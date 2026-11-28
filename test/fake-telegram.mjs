// A fake multi-DC Telegram server speaking real MTProto 2.0 (intermediate transport,
// RSA_PAD key exchange, AES-IGE messages). Replies are serialized with mtcute's
// generated TL writer, so the Worker's parser is tested against an independent encoder.
import net from 'node:net'
import zlib from 'node:zlib'
import { createHash, generateKeyPairSync, randomBytes as nodeRandom } from 'node:crypto'
import Long from 'long'
import { TlBinaryWriter } from '@mtcute/tl-runtime'
import { __tlWriterMap } from '@mtcute/tl/binary/writer.js'
import { TlReader } from '../src/mtproto/tl.js'
import { igeEncrypt, igeDecrypt } from '../src/mtproto/crypto.js'
import { DH_PRIME } from '../src/mtproto/auth.js'
import * as B from '../src/mtproto/bytes.js'

const sha1 = (...p) => new Uint8Array(createHash('sha1').update(B.concat(...p)).digest())
const sha256 = (...p) => new Uint8Array(createHash('sha256').update(B.concat(...p)).digest())
const ser = (obj) => TlBinaryWriter.serializeObject(__tlWriterMap, obj)
const L = (big) => Long.fromString(BigInt.asIntN(64, BigInt(big)).toString())
const rnd = (n) => new Uint8Array(nodeRandom(n))
const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true)

function tlbytes(b) {
  const w = new TlBinaryWriter(__tlWriterMap, new Uint8Array(b.length + 8))
  w.bytes(b)
  return w.result()
}

// Deterministic file content: byte i = f(i)
export function fileByte(seed, i) {
  let x = (i * 2654435761 + seed * 40503) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  return x & 255
}
export function fileBytes(seed, start, end) {
  const out = new Uint8Array(end - start)
  for (let i = start; i < end; i++) out[i - start] = fileByte(seed, i)
  return out
}

export function makeRsaKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const jwk = privateKey.export({ format: 'jwk' })
  const b64 = (s) => B.bytesToBig(new Uint8Array(Buffer.from(s, 'base64url')))
  const n = b64(jwk.n), e = b64(jwk.e), d = b64(jwk.d)
  const fpBytes = sha1(tlbytes(B.bigToBytes(n, 256)), tlbytes(B.bigToBytes(e))).subarray(12, 20)
  const fp = BigInt.asUintN(64, B.readLongLE(fpBytes))
  return { n, e, d, fp }
}

export class World {
  constructor(opts = {}) {
    this.rsa = opts.rsa || makeRsaKey()
    this.rejectRsaPad = !!opts.rejectRsaPad
    this.apiId = 12345
    this.apiHash = '0123456789abcdef0123456789abcdef'
    this.bots = new Map([['111:AAA-test-token', { id: 7001, home: 4 }], ['222:BBB-other', { id: 7002, home: 2 }]])
    this.channelId = 1234567890
    this.channelAccessHash = 0x1122334455667788n
    this.fileDc = 5
    this.fileRefVersion = 1
    this.getFileCalls = 0
    this.expireRefAfter = opts.expireRefAfter ?? 3 // FILE_REFERENCE_EXPIRED once, after this many getFile calls
    this.flood = null // { count, seconds }: the next `count` getFile calls answer FLOOD_WAIT_<seconds>
    this.files = new Map([
      [11, { id: 9001n, accessHash: -5555n, size: 5 * 1048576 + 123457, name: 'Arinthum Ariyamalum (2005) 1080p.mkv', mime: 'video/x-matroska', seed: 11 }],
      [12, { id: 9002n, accessHash: 6666n, size: 9 * 1048576 + 99, name: 'Pattiyal (2006) 720p.mp4', mime: 'video/mp4', seed: 12 }],
      [13, { id: 9003n, accessHash: 7777n, size: 777, name: 'tiny.mkv', mime: 'video/x-matroska', seed: 13 }],
    ])
    this.authKeys = new Map() // hex(auth_key_id) -> { authKey, salt, dc, bot: botId|null, badSaltSent }
    this.exported = new Map() // id -> { bytes, dc, bot }
    this.log = []
    this.servers = []
  }

  fileRef() { return new Uint8Array([0xfe, this.fileRefVersion, 1, 2, 3, 4, 5, 6]) }

  async start(dcs = [1, 2, 3, 4, 5]) {
    this.ports = {}
    for (const dc of dcs) {
      const srv = net.createServer((sock) => new Conn(this, dc, sock))
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      this.ports[dc] = srv.address().port
      this.servers.push(srv)
    }
    return this.ports
  }

  stop() { for (const s of this.servers) s.close() }

  forgetKeysForDc(dc) {
    for (const [k, v] of this.authKeys) if (v.dc === dc) this.authKeys.delete(k)
  }
}

const RPC_ERROR = (code, text) => ser({ _: 'mt_rpc_error', errorCode: code, errorMessage: text })

class Conn {
  constructor(world, dc, sock) {
    this.w = world
    this.dc = dc
    this.sock = sock
    this.buf = Buffer.alloc(0)
    this.started = false
    this.sessions = new Set()
    this.lastMsgId = 0n
    this.dh = null
    sock.on('data', (d) => this.onData(d))
    sock.on('error', () => {})
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    if (!this.started) {
      if (this.buf.length < 4) return
      if (this.buf.readUInt32LE(0) !== 0xeeeeeeee) return this.sock.destroy()
      this.buf = this.buf.subarray(4)
      this.started = true
    }
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) break
      const pkt = new Uint8Array(this.buf.subarray(4, 4 + len))
      this.buf = this.buf.subarray(4 + len)
      try { this.onPacket(pkt) } catch (e) { console.error('[fake-tg] error', e); this.sock.destroy() }
    }
  }

  sendRaw(payload) {
    const h = Buffer.alloc(4)
    h.writeUInt32LE(payload.length)
    this.sock.write(Buffer.concat([h, Buffer.from(payload)]))
  }

  serverMsgId(contentRelated = true) {
    const now = BigInt(Math.floor(Date.now() / 1000)) << 32n
    let id = now | (contentRelated ? 1n : 3n)
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n
    this.lastMsgId = id
    return id
  }

  // ---------- unencrypted (key exchange) ----------
  onPacket(pkt) {
    if (u32(pkt, 0) === 0 && u32(pkt, 4) === 0) return this.onPlain(new TlReader(pkt, 20).raw(u32(pkt, 16)))
    return this.onEncrypted(pkt)
  }

  sendPlain(body) {
    const out = new Uint8Array(20 + body.length)
    const dv = new DataView(out.buffer)
    dv.setBigInt64(8, this.serverMsgId(), true)
    dv.setUint32(16, body.length, true)
    out.set(body, 20)
    this.sendRaw(out)
  }

  onPlain(body) {
    const r = new TlReader(body)
    const id = r.uint()
    const W = this.w
    if (id === 0xbe7e8ef1) { // req_pq_multi
      const nonce = new Uint8Array(r.int128())
      const serverNonce = rnd(16)
      const p = 1229739323n, q = 1402015859n
      this.dh = { nonce, serverNonce, p, q }
      return this.sendPlain(ser({
        _: 'mt_resPQ', nonce, serverNonce, pq: B.bigToBytes(p * q),
        serverPublicKeyFingerprints: [L(0x1234n), L(W.rsa.fp)],
      }))
    }
    if (id === 0xd712e4be) { // req_DH_params
      const nonce = r.int128(), serverNonce = r.int128()
      r.bytes(); r.bytes()
      const fp = BigInt.asUintN(64, r.long())
      const enc = r.bytes()
      if (!B.equal(nonce, this.dh.nonce) || !B.equal(serverNonce, this.dh.serverNonce) || fp !== W.rsa.fp) throw new Error('bad req_DH_params')
      const m = B.bigToBytes(B.modPow(B.bytesToBig(enc), W.rsa.d, W.rsa.n), 256)
      // RSA_PAD (current scheme)?
      const aesEncrypted = m.subarray(32)
      const tempKey = B.xor(m.subarray(0, 32), sha256(aesEncrypted))
      const withHash = igeDecrypt(aesEncrypted, tempKey, new Uint8Array(32))
      const withPadding = B.reversed(withHash.subarray(0, 192))
      let ir
      if (B.equal(sha256(tempKey, withPadding), withHash.subarray(192))) {
        if (W.rejectRsaPad) { W.log.push(`dc${this.dc}: refused RSA_PAD`); return this.sock.destroy() }
        ir = new TlReader(withPadding)
        W.log.push(`dc${this.dc}: RSA_PAD`)
      } else {
        // legacy scheme: 0x00 || SHA1(data) || data || padding
        if (m[0] !== 0) throw new Error('RSA payload not recognised')
        ir = new TlReader(m, 21)
        const start = ir.pos
        const cid = ir.uint()
        ir.pos = start
        const probe = new TlReader(m, 21)
        probe.uint(); probe.bytes(); probe.bytes(); probe.bytes(); probe.int128(); probe.int128(); probe.int256()
        if (cid === 0xa9f55f95) probe.int()
        if (!B.equal(sha1(m.subarray(21, probe.pos)), m.subarray(1, 21))) throw new Error('legacy RSA hash mismatch')
        W.log.push(`dc${this.dc}: legacy RSA`)
      }
      const cid = ir.uint()
      if (cid !== 0xa9f55f95 && cid !== 0x83c95aec) throw new Error('expected p_q_inner_data')
      const pq = B.bytesToBig(ir.bytes()), p = B.bytesToBig(ir.bytes()), q = B.bytesToBig(ir.bytes())
      ir.int128(); ir.int128()
      const newNonce = new Uint8Array(ir.int256())
      const dcField = cid === 0xa9f55f95 ? ir.int() : this.dc
      if (pq !== this.dh.p * this.dh.q || p !== this.dh.p || q !== this.dh.q) throw new Error('bad factorization')
      if (dcField !== this.dc) throw new Error(`p_q_inner_data dc ${dcField} != ${this.dc}`)
      const a = B.bytesToBig(rnd(256))
      const gA = B.modPow(3n, a, DH_PRIME)
      const answer = ser({
        _: 'mt_server_DH_inner_data', nonce, serverNonce, g: 3, dhPrime: B.bigToBytes(DH_PRIME, 256),
        gA: B.bigToBytes(gA, 256), serverTime: Math.floor(Date.now() / 1000),
      })
      let withHash2 = B.concat(sha1(answer), answer)
      if (withHash2.length % 16) withHash2 = B.concat(withHash2, rnd(16 - (withHash2.length % 16)))
      const t = tmpKeyIv(newNonce, serverNonce)
      Object.assign(this.dh, { newNonce, a, tmp: t })
      return this.sendPlain(ser({ _: 'mt_server_DH_params_ok', nonce, serverNonce, encryptedAnswer: igeEncrypt(withHash2, t.key, t.iv) }))
    }
    if (id === 0xf5045f1f) { // set_client_DH_params
      const nonce = new Uint8Array(r.int128()), serverNonce = new Uint8Array(r.int128())
      const dec = igeDecrypt(r.bytes(), this.dh.tmp.key, this.dh.tmp.iv)
      const ir = new TlReader(dec, 20)
      if (ir.uint() !== 0x6643b654) throw new Error('expected client_DH_inner_data')
      ir.int128(); ir.int128(); ir.long()
      const gB = B.bytesToBig(ir.bytes())
      if (!B.equal(sha1(dec.subarray(20, ir.pos)), dec.subarray(0, 20))) throw new Error('client DH hash mismatch')
      const authKey = B.bigToBytes(B.modPow(gB, this.dh.a, DH_PRIME), 256)
      const aux = sha1(authKey).subarray(0, 8)
      const salt = B.readLongLE(B.xor(this.dh.newNonce.subarray(0, 8), serverNonce.subarray(0, 8)))
      this.w.authKeys.set(B.toHex(sha1(authKey).subarray(12, 20)), { authKey, salt, dc: this.dc, bot: null, badSaltSent: false })
      this.w.log.push(`dc${this.dc}: new auth key`)
      return this.sendPlain(ser({
        _: 'mt_dh_gen_ok', nonce, serverNonce,
        newNonceHash1: sha1(this.dh.newNonce, new Uint8Array([1]), aux).subarray(4, 20),
      }))
    }
    throw new Error('unexpected plain message 0x' + id.toString(16))
  }

  // ---------- encrypted ----------
  onEncrypted(pkt) {
    const key = this.w.authKeys.get(B.toHex(pkt.subarray(0, 8)))
    if (!key || key.dc !== this.dc) {
      // real Telegram answers an unknown auth key with transport error -404
      const e = new Uint8Array(4)
      new DataView(e.buffer).setInt32(0, -404, true)
      this.sendRaw(e)
      return setTimeout(() => this.sock.destroy(), 20)
    }
    this.key = key
    const msgKey = pkt.subarray(8, 24)
    const { aesKey, aesIv } = kdf(key.authKey, msgKey, 0)
    const plain = igeDecrypt(pkt.subarray(24), aesKey, aesIv)
    if (!B.equal(sha256(key.authKey.subarray(88, 120), plain).subarray(8, 24), msgKey)) throw new Error('client msg_key mismatch')
    const dv = new DataView(plain.buffer, plain.byteOffset)
    const salt = dv.getBigInt64(0, true)
    const sessionId = plain.slice(8, 16)
    const msgId = dv.getBigInt64(16, true)
    const seqNo = dv.getInt32(24, true)
    const len = dv.getInt32(28, true)
    const body = plain.subarray(32, 32 + len)
    if (msgId % 4n !== 0n) throw new Error('client msg_id not divisible by 4')
    this.sessionId = sessionId
    const sKey = B.toHex(sessionId)
    if (!this.sessions.has(sKey)) {
      this.sessions.add(sKey)
      this.send(ser({ _: 'mt_new_session_created', firstMsgId: L(msgId), uniqueId: L(5n), serverSalt: L(key.salt) }), false)
    }
    if (!key.badSaltSent && seqNo & 1) {
      // force one salt rotation per auth key to exercise bad_server_salt handling
      key.badSaltSent = true
      key.salt = B.readLongLE(rnd(8))
      return this.send(ser({ _: 'mt_bad_server_salt', badMsgId: L(msgId), badMsgSeqno: seqNo, errorCode: 48, newServerSalt: L(key.salt) }), false)
    }
    if (salt !== key.salt) {
      return this.send(ser({ _: 'mt_bad_server_salt', badMsgId: L(msgId), badMsgSeqno: seqNo, errorCode: 48, newServerSalt: L(key.salt) }), false)
    }
    this.handleBody(msgId, body)
  }

  send(body, contentRelated = true) {
    const key = this.key
    const msgId = this.serverMsgId(contentRelated)
    const seq = contentRelated ? 1 : 0
    let pad = 16 - ((32 + body.length) % 16)
    if (pad < 12) pad += 16
    const plain = new Uint8Array(32 + body.length + pad)
    const dv = new DataView(plain.buffer)
    dv.setBigInt64(0, BigInt.asIntN(64, key.salt), true)
    plain.set(this.sessionId, 8)
    dv.setBigInt64(16, msgId, true)
    dv.setInt32(24, seq, true)
    dv.setInt32(28, body.length, true)
    plain.set(body, 32)
    plain.set(rnd(pad), 32 + body.length)
    const msgKey = sha256(key.authKey.subarray(96, 128), plain).subarray(8, 24)
    const { aesKey, aesIv } = kdf(key.authKey, msgKey, 8)
    this.sendRaw(B.concat(sha1(key.authKey).subarray(12, 20), msgKey, igeEncrypt(plain, aesKey, aesIv)))
  }

  rpcResult(reqMsgId, result, { gzip = false } = {}) {
    let res = result
    if (gzip) {
      const w = new TlBinaryWriter(__tlWriterMap, new Uint8Array(result.length + 64))
      w.uint(0x3072cfa1)
      w.bytes(new Uint8Array(zlib.gzipSync(result)))
      res = w.result()
    }
    const out = new Uint8Array(12 + res.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, 0xf35c6d01, true)
    dv.setBigInt64(4, reqMsgId, true)
    out.set(res, 12)
    this.rpcCount = (this.rpcCount || 0) + 1
    if (this.rpcCount % 3 === 0) {
      // like real Telegram, sometimes batch the answer with an ack in a msg_container
      const ack = ser({ _: 'mt_msgs_ack', msgIds: [L(reqMsgId)] })
      const items = [[this.serverMsgId(true), 1, out], [this.serverMsgId(false), 0, ack]]
      const c = new Uint8Array(8 + items.reduce((n, [, , b]) => n + 16 + b.length, 0))
      const cv = new DataView(c.buffer)
      cv.setUint32(0, 0x73f1f8dc, true)
      cv.setUint32(4, items.length, true)
      let o = 8
      for (const [mid, seq, b] of items) {
        cv.setBigInt64(o, mid, true); cv.setInt32(o + 8, seq, true); cv.setInt32(o + 12, b.length, true)
        c.set(b, o + 16)
        o += 16 + b.length
      }
      return this.send(c, false)
    }
    this.send(out, true)
  }

  handleBody(msgId, body) {
    const r = new TlReader(body)
    let id = r.uint()
    if (id === 0x62d6b459) return // msgs_ack
    if (id === 0x7abe77ec) return this.send(ser({ _: 'mt_pong', msgId: L(msgId), pingId: L(r.long()) }), false)
    // unwrap invokeWithLayer / initConnection
    let initApiId = null
    for (;;) {
      if (id === 0xda9b0d0d) { r.int(); id = r.uint(); continue }
      if (id === 0xc1cd5ea9) {
        r.uint(); initApiId = r.int()
        for (let i = 0; i < 6; i++) r.string()
        id = r.uint()
        continue
      }
      break
    }
    if (initApiId !== null) this.initDone = true
    if (!this.initDone) return this.rpcResult(msgId, RPC_ERROR(400, 'CONNECTION_NOT_INITED'))
    this.api(msgId, id, r)
  }

  api(msgId, id, r) {
    const W = this.w
    const key = this.key
    const needAuth = () => {
      if (!key.bot) { this.rpcResult(msgId, RPC_ERROR(401, 'AUTH_KEY_UNREGISTERED')); return false }
      return true
    }
    const botUser = (botId) => ({ _: 'user', id: botId, bot: true, botInfoVersion: 1, firstName: 'Test bot', username: 'test_bot', accessHash: L(42n) })
    switch (id) {
      case 0x67a3ff2c: { // auth.importBotAuthorization
        r.int(); const apiId = r.int(); const apiHash = r.string(); const token = r.string()
        const bot = W.bots.get(token)
        if (apiId !== W.apiId || apiHash !== W.apiHash) return this.rpcResult(msgId, RPC_ERROR(400, 'API_ID_INVALID'))
        if (!bot) return this.rpcResult(msgId, RPC_ERROR(400, 'ACCESS_TOKEN_INVALID'))
        if (this.dc !== bot.home) return this.rpcResult(msgId, RPC_ERROR(303, 'USER_MIGRATE_' + bot.home))
        key.bot = bot.id
        W.log.push(`dc${this.dc}: bot ${bot.id} logged in`)
        return this.rpcResult(msgId, ser({ _: 'auth.authorization', user: botUser(bot.id) }))
      }
      case 0xe5bfffcd: { // auth.exportAuthorization
        if (!needAuth()) return
        const dc = r.int()
        const eid = B.readLongLE(rnd(8))
        const bytes = rnd(64)
        W.exported.set(String(eid), { bytes, dc, bot: key.bot })
        return this.rpcResult(msgId, ser({ _: 'auth.exportedAuthorization', id: L(eid), bytes }))
      }
      case 0xa57a7dad: { // auth.importAuthorization
        const eid = String(r.long()); const bytes = r.bytes()
        const ex = W.exported.get(eid)
        if (!ex || ex.dc !== this.dc || !B.equal(ex.bytes, bytes)) return this.rpcResult(msgId, RPC_ERROR(400, 'AUTH_BYTES_INVALID'))
        W.exported.delete(eid)
        key.bot = ex.bot
        W.log.push(`dc${this.dc}: authorization imported`)
        return this.rpcResult(msgId, ser({ _: 'auth.authorization', user: botUser(ex.bot) }))
      }
      case 0x0a7f6bbb: { // channels.getChannels
        if (!needAuth()) return
        r.uint(); const n = r.uint()
        const chats = []
        for (let i = 0; i < n; i++) {
          r.uint(); const chId = r.int53(); r.long()
          if (chId === W.channelId) {
            chats.push({ _: 'channel', id: chId, accessHash: L(W.channelAccessHash), title: 'test channel', photo: { _: 'chatPhotoEmpty' }, date: 1700000000, broadcast: true })
          }
        }
        if (!chats.length) return this.rpcResult(msgId, RPC_ERROR(400, 'CHANNEL_INVALID'))
        return this.rpcResult(msgId, ser({ _: 'messages.chats', chats }))
      }
      case 0xad8c9a23: { // channels.getMessages
        if (!needAuth()) return
        r.uint(); const chId = r.int53(); const ah = r.long()
        if (chId !== W.channelId || ah !== W.channelAccessHash) return this.rpcResult(msgId, RPC_ERROR(400, 'CHANNEL_INVALID'))
        r.uint(); const n = r.uint()
        const messages = []
        for (let i = 0; i < n; i++) {
          r.uint(); const mid = r.int()
          const f = W.files.get(mid)
          if (!f) { messages.push({ _: 'messageEmpty', id: mid }); continue }
          messages.push({
            _: 'message', id: mid, post: true, peerId: { _: 'peerChannel', channelId: W.channelId }, date: 1700000000, message: f.name,
            media: {
              _: 'messageMediaDocument', video: true,
              document: {
                _: 'document', id: L(f.id), accessHash: L(f.accessHash), fileReference: W.fileRef(), date: 1700000000,
                mimeType: f.mime, size: f.size, dcId: W.fileDc,
                attributes: [
                  { _: 'documentAttributeVideo', supportsStreaming: true, duration: 7200, w: 1920, h: 1080 },
                  { _: 'documentAttributeFilename', fileName: f.name },
                ],
              },
            },
          })
        }
        const res = ser({
          _: 'messages.channelMessages', pts: 1, count: n, messages, topics: [],
          chats: [{ _: 'channel', id: W.channelId, accessHash: L(W.channelAccessHash), title: 'test channel', photo: { _: 'chatPhotoEmpty' }, date: 1700000000, broadcast: true }],
          users: [],
        })
        return this.rpcResult(msgId, res, { gzip: true })
      }
      case 0xbe5335be: { // upload.getFile
        if (!needAuth()) return
        r.uint()
        if (r.uint() !== 0xbad07584) return this.rpcResult(msgId, RPC_ERROR(400, 'LOCATION_INVALID'))
        const docId = r.long(); const ah = r.long(); const ref = r.bytes(); r.string()
        const offset = r.int53(); const limit = r.int()
        if (this.dc !== W.fileDc) return this.rpcResult(msgId, RPC_ERROR(303, 'FILE_MIGRATE_' + W.fileDc))
        const f = [...W.files.values()].find((x) => x.id === docId && x.accessHash === ah)
        if (!f) return this.rpcResult(msgId, RPC_ERROR(400, 'FILE_ID_INVALID'))
        if (W.flood && W.flood.count > 0) { W.flood.count--; return this.rpcResult(msgId, RPC_ERROR(420, 'FLOOD_WAIT_' + W.flood.seconds)) }
        W.getFileCalls++
        if (W.expireRefAfter && W.getFileCalls === W.expireRefAfter) { W.fileRefVersion++; W.expireRefAfter = 0 }
        if (!B.equal(ref, W.fileRef())) return this.rpcResult(msgId, RPC_ERROR(400, 'FILE_REFERENCE_EXPIRED'))
        if (offset % 4096 || limit % 4096 || 1048576 % limit || Math.floor(offset / 1048576) !== Math.floor((offset + limit - 1) / 1048576)) {
          return this.rpcResult(msgId, RPC_ERROR(400, 'LIMIT_INVALID'))
        }
        const end = Math.min(f.size, offset + limit)
        const bytes = offset >= f.size ? new Uint8Array(0) : fileBytes(f.seed, offset, end)
        return this.rpcResult(msgId, ser({ _: 'upload.file', type: { _: 'storage.fileMp4' }, mtime: 1700000000, bytes }))
      }
      default:
        return this.rpcResult(msgId, RPC_ERROR(400, 'METHOD_INVALID'))
    }
  }
}

function tmpKeyIv(newNonce, serverNonce) {
  const a = sha1(newNonce, serverNonce), b = sha1(serverNonce, newNonce), c = sha1(newNonce, newNonce)
  return { key: B.concat(a, b.subarray(0, 12)), iv: B.concat(b.subarray(12, 20), c, newNonce.subarray(0, 4)) }
}

function kdf(authKey, msgKey, x) {
  const a = sha256(msgKey, authKey.subarray(x, x + 36))
  const b = sha256(authKey.subarray(40 + x, 40 + x + 36), msgKey)
  return {
    aesKey: B.concat(a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)),
    aesIv: B.concat(b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)),
  }
}
