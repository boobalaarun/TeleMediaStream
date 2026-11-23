// One MTProto 2.0 session over one TCP connection. Many requests can be in flight at once
// (each file part is a separate upload.getFile); answers are matched by msg_id.
import * as B from './bytes.js'
import { sha1, sha256, sha256Async, igeEncrypt, igeDecrypt, gunzip } from './crypto.js'
import { TlReader, msgsAck, invokeWithLayer, initConnection } from './tl.js'
import { Transport } from './transport.js'

export class RpcError extends Error {
  constructor(code, message) {
    super(`${code} ${message}`)
    this.code = code
    this.text = message
    const m = /_(\d+)$/.exec(message)
    this.value = m ? Number(m[1]) : null
  }
  is(prefix) {
    return this.text === prefix || this.text.startsWith(prefix + '_') || this.text.startsWith(prefix)
  }
}

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

function kdf(authKey, msgKey, x) {
  const a = sha256(B.concat(msgKey, authKey.subarray(x, x + 36)))
  const b = sha256(B.concat(authKey.subarray(40 + x, 40 + x + 36), msgKey))
  return {
    key: B.concat(a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)),
    iv: B.concat(b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)),
  }
}

export class Session {
  /**
   * opts: { connect, host, port, dcId, authKey?, salt?, timeOffset?, apiId?, onSalt?, log? }
   */
  constructor(opts) {
    this.opts = opts
    this.dcId = opts.dcId
    this.transport = new Transport(opts.connect, opts.host, opts.port)
    this.timeOffset = opts.timeOffset || 0
    this.pending = new Map()
    this.ackQueue = []
    this.ackTimer = null
    this.lastMsgId = 0n
    this.seq = 0
    this.closed = false
    this.initDone = false
    this.plainWaiter = null
    this.chain = Promise.resolve()
    this.setAuthKey(opts.authKey || null, opts.salt || 0n)
  }

  setAuthKey(authKey, salt) {
    this.authKey = authKey
    this.salt = salt
    this.sessionId = B.randomBytes(8)
    this.seq = 0
    if (authKey) {
      this.authKeyId = sha1(authKey).subarray(12, 20)
      this.authKeyIn = authKey.subarray(96, 128) // auth_key[88+x .. +32], x = 8 (server -> client)
      this.authKeyOut = authKey.subarray(88, 120) // x = 0 (client -> server)
    }
  }

  get busy() { return this.pending.size }
  get idleMs() { return this.pending.size ? 0 : Date.now() - this.transport.lastActivity }

  async open() {
    this.transport.onPacket = (pkt) => {
      this.chain = this.chain.then(() => this._onPacket(pkt)).catch((e) => this.close(e))
    }
    this.transport.onClose = (err) => this._onClosed(err)
    await this.transport.open(this.opts.connectTimeoutMs)
  }

  close(err) {
    this.transport.close(err)
  }

  _onClosed(err) {
    if (this.closed) return
    this.closed = true
    if (this.ackTimer) clearTimeout(this.ackTimer)
    const e = err || new Error('connection closed')
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
    if (this.plainWaiter) { this.plainWaiter.reject(e); this.plainWaiter = null }
    if (this.opts.onClose) this.opts.onClose(this, e)
  }

  _nextMsgId() {
    const now = Date.now() + this.timeOffset * 1000
    const sec = BigInt(Math.floor(now / 1000))
    const frac = BigInt(Math.floor((now % 1000) * 4294967.296)) & ~3n
    let id = (sec << 32n) | frac
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n
    this.lastMsgId = id
    return id
  }

  _nextSeq(contentRelated) {
    if (contentRelated) return this.seq++ * 2 + 1
    return this.seq * 2
  }

  // ---------- unencrypted messages (key exchange) ----------
  plainCall(body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'))
      const timer = setTimeout(() => {
        if (this.plainWaiter && this.plainWaiter.timer === timer) this.plainWaiter = null
        reject(new Error('Telegram did not answer the key exchange'))
      }, timeoutMs)
      this.plainWaiter = {
        timer,
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      const pkt = new Uint8Array(20 + body.length)
      const dv = new DataView(pkt.buffer)
      dv.setBigInt64(8, this._nextMsgId(), true)
      dv.setUint32(16, body.length, true)
      pkt.set(body, 20)
      this.transport.send(pkt).catch(reject)
    })
  }

  // ---------- encrypted messages ----------
  _encrypt(msgId, seqNo, body) {
    let pad = 16 - ((32 + body.length) % 16)
    if (pad < 12) pad += 16
    const plain = new Uint8Array(32 + body.length + pad)
    const dv = new DataView(plain.buffer)
    dv.setBigInt64(0, BigInt.asIntN(64, this.salt), true)
    plain.set(this.sessionId, 8)
    dv.setBigInt64(16, msgId, true)
    dv.setInt32(24, seqNo, true)
    dv.setInt32(28, body.length, true)
    plain.set(body, 32)
    crypto.getRandomValues(plain.subarray(32 + body.length))
    const msgKey = sha256(B.concat(this.authKeyOut, plain)).subarray(8, 24)
    const { key, iv } = kdf(this.authKey, msgKey, 0)
    return B.concat(this.authKeyId, msgKey, igeEncrypt(plain, key, iv))
  }

  _send(msgId, seqNo, body) {
    return this.transport.send(this._encrypt(msgId, seqNo, body))
  }

  /**
   * Invoke an API method. body: serialized TL. Resolves with the parsed result object.
   * The first request(s) on a connection are wrapped in invokeWithLayer(initConnection(...)).
   */
  invoke(body, { timeoutMs = 60000 } = {}) {
    if (!this.authKey) return Promise.reject(new Error('no auth key'))
    if (!this.initDone && this.opts.apiId) body = invokeWithLayer(initConnection(this.opts.apiId, body))
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'))
      const msgId = this._nextMsgId()
      const p = { body, resolve, reject, timer: null }
      p.timer = setTimeout(() => {
        if (this.pending.get(p.msgId) === p) this.pending.delete(p.msgId)
        reject(new Error('Telegram request timed out'))
      }, timeoutMs)
      p.msgId = msgId
      this.pending.set(msgId, p)
      this._send(msgId, this._nextSeq(true), body).catch((e) => {
        this.pending.delete(msgId)
        clearTimeout(p.timer)
        reject(e)
      })
    })
  }

  _resend(oldId) {
    const p = this.pending.get(oldId)
    if (!p) return
    this.pending.delete(oldId)
    const msgId = this._nextMsgId()
    p.msgId = msgId
    this.pending.set(msgId, p)
    this._send(msgId, this._nextSeq(true), p.body).catch((e) => {
      this.pending.delete(msgId)
      clearTimeout(p.timer)
      p.reject(e)
    })
  }

  _queueAck(msgId) {
    this.ackQueue.push(msgId)
    if (this.ackQueue.length >= 16) return this._flushAcks()
    if (!this.ackTimer) this.ackTimer = setTimeout(() => this._flushAcks(), 150)
  }

  _flushAcks() {
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null }
    if (!this.ackQueue.length || this.closed) return
    const ids = this.ackQueue.splice(0)
    this._send(this._nextMsgId(), this._nextSeq(false), msgsAck(ids)).catch(() => {})
  }

  async _onPacket(pkt) {
    if (this.closed) return
    // unencrypted reply during key exchange: auth_key_id == 0
    if (u32(pkt, 0) === 0 && u32(pkt, 4) === 0) {
      const len = u32(pkt, 16)
      const w = this.plainWaiter
      this.plainWaiter = null
      if (w) w.resolve(pkt.subarray(20, 20 + len))
      return
    }
    if (!this.authKey) throw new Error('encrypted message without auth key')
    if (!B.equal(pkt.subarray(0, 8), this.authKeyId)) throw new Error('auth_key_id mismatch')
    const msgKey = pkt.subarray(8, 24)
    const { key, iv } = kdf(this.authKey, msgKey, 8)
    const buf = igeDecrypt(pkt.subarray(24), key, iv, this.authKeyIn)
    const hash = await sha256Async(buf)
    if (!B.equal(hash.subarray(8, 24), msgKey)) throw new Error('msg_key mismatch')
    const plain = buf.subarray(32)
    if (!B.equal(plain.subarray(8, 16), this.sessionId)) return // stale message from another session
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
    const msgId = dv.getBigInt64(16, true)
    const seqNo = dv.getInt32(24, true)
    const len = dv.getUint32(28, true)
    if (len % 4 !== 0 || len > plain.length - 32 || plain.length - 32 - len < 12 || plain.length - 32 - len > 1024) {
      throw new Error('bad message length')
    }
    this._handle(msgId, seqNo, plain.subarray(32, 32 + len))
  }

  _handle(msgId, seqNo, body) {
    if (seqNo & 1) this._queueAck(msgId)
    const id = u32(body, 0)
    if (id === 0x73f1f8dc) { // msg_container
      const r = new TlReader(body, 4)
      const n = r.uint()
      for (let i = 0; i < n; i++) {
        const mid = r.long(), seq = r.int(), len = r.int()
        this._handle(mid, seq, r.raw(len))
      }
      return
    }
    if (id === 0xf35c6d01) { // rpc_result
      const reqId = new DataView(body.buffer, body.byteOffset + 4, 8).getBigInt64(0, true)
      return this._rpcResult(reqId, body.subarray(12))
    }
    if (id === 0x3072cfa1) { // gzip_packed
      return this._handle(msgId, 0, gunzip(new TlReader(body, 4).bytes()))
    }
    let obj
    try { obj = new TlReader(body).object() } catch { return } // unknown update etc.
    switch (obj && obj._) {
      case 'mt_bad_server_salt':
        this.salt = obj.newServerSalt
        if (this.opts.onSalt) this.opts.onSalt(this.salt)
        this._resend(obj.badMsgId)
        break
      case 'mt_new_session_created':
        this.salt = obj.serverSalt
        if (this.opts.onSalt) this.opts.onSalt(this.salt)
        break
      case 'mt_bad_msg_notification': {
        const p = this.pending.get(obj.badMsgId)
        if (obj.errorCode === 16 || obj.errorCode === 17) {
          // our clock is off: sync to the server's msg_id time and resend
          this.timeOffset = Number(msgId >> 32n) - Math.floor(Date.now() / 1000)
          this.lastMsgId = 0n
          this._resend(obj.badMsgId)
        } else if (obj.errorCode === 32 || obj.errorCode === 33) {
          // seq_no out of sync: start a fresh session and resend everything
          this.sessionId = B.randomBytes(8)
          this.seq = 0
          for (const k of [...this.pending.keys()]) this._resend(k)
        } else if (p) {
          this.pending.delete(obj.badMsgId)
          clearTimeout(p.timer)
          p.reject(new Error('bad_msg_notification ' + obj.errorCode))
        }
        break
      }
      case 'mt_msg_detailed_info':
      case 'mt_msg_new_detailed_info':
        this._queueAck(obj.answerMsgId)
        break
      default:
        break // acks, pongs, updates: nothing to do
    }
  }

  _rpcResult(reqId, result) {
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    clearTimeout(p.timer)
    try {
      let id = u32(result, 0)
      if (id === 0x3072cfa1) {
        result = gunzip(new TlReader(result, 4).bytes())
        id = u32(result, 0)
      }
      if (id === 0x2144ca19) {
        const r = new TlReader(result, 4)
        const code = r.int()
        p.reject(new RpcError(code, r.string()))
        return
      }
      this.initDone = true
      p.resolve(new TlReader(result).object())
    } catch (e) {
      p.reject(e)
    }
  }
}
