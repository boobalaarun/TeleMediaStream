// Telegram side: one bot account, auth keys per data centre, a small connection pool per DC,
// message lookup and file-part download. All state that must survive restarts goes through
// `storage` (Durable Object storage in production, a Map in tests).
import { Session, RpcError } from './mtproto/session.js'
import { TransportError } from './mtproto/transport.js'
import { createAuthKey } from './mtproto/auth.js'
import { sha256 } from './mtproto/crypto.js'
import { toHex, sleep } from './mtproto/bytes.js'
import * as TL from './mtproto/tl.js'

export const PART = 1024 * 1024
const MAX_CONN_PER_DC = 2
// Workers allow 6 open outgoing connections and queue the rest. Keep Telegram at 4 so a new DC
// and the calls to the app always have room; a second connection to a DC is only a bonus.
const MAX_TG_CONNECTIONS = 4
const IDLE_CLOSE_MS = 30000
// A 1 MB part normally arrives in about a second; one that takes this long is asked for again
const PART_TIMEOUT_MS = 15000
const FIRST_DC = 2

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const enc = new TextEncoder()
const tokenHash = (t) => toHex(sha256(enc.encode(t))).slice(0, 16)

export class TelegramClient {
  /**
   * opts: { connect, storage, dcAddrs: {dc: [host, port]}, rsaKeys: [{fp,n,e}] (BigInt),
   *         getAppConfig: () => Promise<{apiId, apiHash, bots}>, log,
   *         onFlood?: ({ seconds, waited, dc, text }) => void  (each FLOOD_WAIT from Telegram),
   *         silentMs?: a connection with requests waiting that receives nothing for this long is
   *           closed and the requests are asked again on a new one (0: off),
   *         onSilent?: ({ dc }) => void  (each connection closed that way),
   *         partTimeoutMs?: a file part not answered this long is asked for again (default 15 s) }
   */
  constructor(opts) {
    this.o = opts
    this.log = opts.log || (() => {})
    this.pools = new Map()
    this.dc = new Map()
    this.home = null
    this.channelHashes = new Map()
    this.locks = new Map()
    this.loaded = null
    this.reaper = null
  }

  _once(key, fn) {
    let p = this.locks.get(key)
    if (!p) {
      p = fn().finally(() => this.locks.delete(key))
      this.locks.set(key, p)
    }
    return p
  }

  _load() {
    if (!this.loaded) {
      this.loaded = (async () => {
        const keys = ['home', ...Object.keys(this.o.dcAddrs).map((d) => 'dc:' + d)]
        const got = await this.o.storage.get(keys)
        this.home = got.get('home') || null
        for (const d of Object.keys(this.o.dcAddrs)) {
          const st = got.get('dc:' + d)
          if (st) {
            this.dc.set(Number(d), {
              authKey: new Uint8Array(st.authKey),
              salt: BigInt(st.salt),
              authorized: !!st.authorized,
              tokenHash: st.tokenHash || null,
              timeOffset: st.timeOffset || 0,
            })
          }
        }
      })().catch((e) => { this.loaded = null; throw e })
    }
    return this.loaded
  }

  _saveDc(dc) {
    const st = this.dc.get(dc)
    if (!st) return this.o.storage.delete('dc:' + dc)
    return this.o.storage.put('dc:' + dc, {
      authKey: st.authKey,
      salt: String(st.salt),
      authorized: st.authorized,
      tokenHash: st.tokenHash,
      timeOffset: st.timeOffset,
    })
  }

  _addr(dc) {
    const a = this.o.dcAddrs[dc]
    if (!a) throw new Error('unknown Telegram DC ' + dc)
    return a
  }

  async _dropKey(dc) {
    this.log(`dc${dc}: dropping auth key`)
    for (const s of this.pools.get(dc) || []) s.close()
    this.pools.delete(dc)
    this.dc.delete(dc)
    await this._saveDc(dc)
    if (this.home && this.home.dc === dc) {
      this.home = null
      await this.o.storage.delete('home')
    }
  }

  async _forgetAll() {
    for (const pool of this.pools.values()) for (const s of pool) s.close()
    this.pools.clear()
    const dcs = [...this.dc.keys()]
    this.dc.clear()
    this.home = null
    this.channelHashes.clear()
    await this.o.storage.delete(['home', ...dcs.map((d) => 'dc:' + d)])
    const chans = await this.o.storage.list({ prefix: 'chan:' })
    if (chans.size) await this.o.storage.delete([...chans.keys()])
  }

  _ensureKey(dc) {
    const st = this.dc.get(dc)
    if (st) return Promise.resolve(st)
    return this._once('key:' + dc, async () => {
      const [host, port] = this._addr(dc)
      let k, firstErr
      // RSA_PAD for Telegram's current keys, legacy SHA1/RSA for old ones (as mtcute does);
      // if Telegram refuses that, retry once with the other scheme on a fresh connection
      for (const flip of [false, true]) {
        const s = new Session({ connect: this.o.connect, host, port, dcId: dc, connectTimeoutMs: this.o.connectTimeoutMs })
        try {
          await s.open()
          this.log(`dc${dc}: creating auth key${flip ? ' (other RSA scheme)' : ''}`)
          k = await createAuthKey((b) => s.plainCall(b), dc, this.o.rsaKeys, this.o.dhPrime, flip)
          break
        } catch (e) {
          firstErr = firstErr || e
          this.log(`dc${dc}: key exchange failed: ${e.message}`)
        } finally {
          s.close()
        }
      }
      if (!k) throw firstErr
      const st2 = { authKey: k.authKey, salt: k.salt, authorized: false, tokenHash: null, timeOffset: k.timeOffset }
      this.dc.set(dc, st2)
      await this._saveDc(dc)
      return st2
    })
  }

  async _openSession(dc) {
    const st = await this._ensureKey(dc)
    const cfg = await this.o.getAppConfig()
    const [host, port] = this._addr(dc)
    const s = new Session({
      connect: this.o.connect, host, port, dcId: dc, connectTimeoutMs: this.o.connectTimeoutMs,
      authKey: st.authKey, salt: st.salt, timeOffset: st.timeOffset, apiId: cfg.apiId, silentMs: this.o.silentMs,
      onSalt: (salt) => {
        const cur = this.dc.get(dc)
        if (cur && cur.authKey === st.authKey && cur.salt !== salt) { cur.salt = salt; this._saveDc(dc).catch(() => {}) }
      },
      onClose: (sess, e) => {
        const pool = this.pools.get(dc)
        if (pool) this.pools.set(dc, pool.filter((x) => x !== sess))
        if (e && e.silent) {
          // the waiting requests fail now and call() asks them again on another connection
          this.log(`dc${dc}: ${e.message}; closed that connection, asking again on a new one`)
          try { if (this.o.onSilent) this.o.onSilent({ dc }) } catch {}
        }
      },
    })
    await s.open()
    const pool = (this.pools.get(dc) || []).filter((x) => !x.closed)
    pool.push(s)
    this.pools.set(dc, pool)
    this._startReaper()
    return s
  }

  _live(dc) {
    return (this.pools.get(dc) || []).filter((x) => !x.closed)
  }

  _leastBusy(dc) {
    let best = null
    for (const s of this._live(dc)) if (!best || s.busy < best.busy) best = s
    return best
  }

  // Telegram connections open or being opened, across all DCs.
  _openCount() {
    let n = 0
    for (const dc of this.pools.keys()) n += this._live(dc).length
    for (const k of this.locks.keys()) if (k.startsWith('open:') || k.startsWith('key:')) n++
    return n
  }

  // Before a first connection to `dc`: if the budget is used up, close the longest-idle
  // connection to another DC.
  _makeRoom(dc) {
    if (this._openCount() < MAX_TG_CONNECTIONS) return
    let victim = null
    for (const d of this.pools.keys()) {
      if (d === dc) continue
      for (const s of this._live(d)) if (s.busy === 0 && (!victim || s.idleMs > victim.idleMs)) victim = s
    }
    if (victim) {
      this.log(`dc${victim.dcId}: closing an idle connection to make room for DC ${dc}`)
      victim.close()
    }
  }

  async _session(dc) {
    let best = this._leastBusy(dc)
    if (best) {
      // Busy connection: add another in the background, but never make this request wait
      // for it. A connection that is queued or never answered would otherwise freeze every
      // download on this DC (a stream would stop with no error).
      if (best.busy >= 2 && this._live(dc).length < MAX_CONN_PER_DC && !this.locks.has('open:' + dc) &&
          this._openCount() < MAX_TG_CONNECTIONS) {
        this._once('open:' + dc, () => this._openSession(dc))
          .catch((e) => this.log(`dc${dc}: extra connection failed: ${e.message}`))
      }
      return best
    }
    this._makeRoom(dc)
    let err = null
    await this._once('open:' + dc, () => this._openSession(dc)).catch((e) => { err = e })
    best = this._leastBusy(dc)
    if (!best) throw err || new Error(`could not connect to Telegram DC ${dc}`)
    return best
  }

  // For /status: open Telegram connections per DC.
  connectionCounts() {
    const out = {}
    for (const dc of this.pools.keys()) {
      const n = this._live(dc).length
      if (n) out[dc] = n
    }
    return out
  }

  _startReaper() {
    if (this.reaper) return
    this.reaper = setInterval(() => {
      let open = 0
      for (const [dc, pool] of this.pools) {
        const keep = []
        for (const s of pool) {
          if (s.closed) continue
          if (s.idleMs > IDLE_CLOSE_MS) s.close()
          else keep.push(s)
        }
        this.pools.set(dc, keep)
        open += keep.length
      }
      if (!open) { clearInterval(this.reaper); this.reaper = null }
    }, 10000)
  }

  closeAll() {
    for (const pool of this.pools.values()) for (const s of pool) s.close()
    this.pools.clear()
  }

  // ---------- requests with recovery ----------
  async call(dc, body, { authorize = true, timeoutMs } = {}) {
    let lastErr
    for (let attempt = 0; attempt < 4; attempt++) {
      if (authorize) await this.ensureAuthorized(dc)
      const s = await this._session(dc)
      try {
        return await s.invoke(body, timeoutMs ? { timeoutMs } : undefined)
      } catch (e) {
        lastErr = e
        if (e instanceof TransportError && e.code === -404) { await this._dropKey(dc); continue }
        if (e instanceof RpcError) {
          if (e.code === 401) {
            const st = this.dc.get(dc)
            if (st) { st.authorized = false; await this._saveDc(dc) }
            if (this.home && this.home.dc === dc) { this.home = null; await this.o.storage.delete('home') }
            if (!authorize) throw e
            continue
          }
          if (e.text === 'AUTH_KEY_DUPLICATED') { await this._dropKey(dc); continue }
          if (e.code === 420) {
            // FLOOD_WAIT_X: Telegram wants the bot to slow down. Short waits are sat out here;
            // longer ones end this request (and the stream: the player asks again).
            const waitOut = e.value !== null && e.value <= 15
            try { if (this.o.onFlood) this.o.onFlood({ seconds: e.value, waited: waitOut, dc, text: e.text }) } catch {}
            if (waitOut) { await sleep(e.value * 1000 + 300); continue }
          }
          if (e.code === 500 || e.code === -500 || e.code === -503) { await sleep(800); continue }
          throw e
        }
        if (e instanceof HttpError) throw e
        // dropped or silent connection, or a timeout: ask again (a closed session has left the
        // pool, so this goes to another connection or a new one)
        if (attempt < 3) continue
        throw e
      }
    }
    throw lastErr
  }

  async ensureAuthorized(dc) {
    await this._load()
    const cfg = await this.o.getAppConfig()
    if (!cfg.bots || !cfg.bots.length) throw new HttpError(502, 'The app did not provide a bot token')
    const th = tokenHash(cfg.bots[0])
    if (!this.home || this.home.tokenHash !== th) await this._login(cfg, th)
    if (dc === undefined || dc === this.home.dc) {
      const st = this.dc.get(this.home.dc)
      if (!st || !st.authorized || st.tokenHash !== th) await this._login(cfg, th)
      return
    }
    const st = this.dc.get(dc)
    if (st && st.authorized && st.tokenHash === th) return
    await this._once('import:' + dc, async () => {
      this.log(`dc${dc}: importing bot authorization from dc${this.home.dc}`)
      const exp = await this.call(this.home.dc, TL.exportAuthorization(dc))
      await this._ensureKey(dc)
      const imp = await this.call(dc, TL.importAuthorization(exp.id, exp.bytes), { authorize: false })
      if (!imp || !String(imp._).startsWith('auth.')) throw new Error('importAuthorization failed')
      const st2 = this.dc.get(dc)
      st2.authorized = true
      st2.tokenHash = th
      await this._saveDc(dc)
    })
  }

  _login(cfg, th) {
    return this._once('login', async () => {
      if (this.home && this.home.tokenHash !== th) {
        this.log('bot token changed: forgetting old Telegram sessions')
        await this._forgetAll()
      }
      let dc = (this.home && this.home.dc) || FIRST_DC
      for (let i = 0; i < 6; i++) {
        await this._ensureKey(dc)
        this.log(`dc${dc}: logging in the bot`)
        try {
          await this.call(dc, TL.importBotAuthorization(cfg.apiId, cfg.apiHash, cfg.bots[0]), { authorize: false })
        } catch (e) {
          if (e instanceof RpcError && e.code === 303 && e.value) { dc = e.value; continue }
          if (e instanceof RpcError && /ACCESS_TOKEN|BOT_|API_ID/.test(e.text)) {
            throw new HttpError(502, `Telegram rejected the bot login (${e.text}). Check BOT_TOKEN / API_ID / API_HASH in the app.`)
          }
          throw e
        }
        const st = this.dc.get(dc)
        st.authorized = true
        st.tokenHash = th
        await this._saveDc(dc)
        this.home = { dc, tokenHash: th }
        await this.o.storage.put('home', this.home)
        return
      }
      throw new Error('too many data-centre redirects during bot login')
    })
  }

  // ---------- channel / message / file ----------
  async _channelHash(chat, refresh = false) {
    const key = 'chan:' + chat
    if (!refresh) {
      if (this.channelHashes.has(chat)) return this.channelHashes.get(chat)
      const stored = await this.o.storage.get(key)
      if (stored !== undefined) { const v = BigInt(stored); this.channelHashes.set(chat, v); return v }
    }
    let res
    try {
      res = await this.call(this.home.dc, TL.channelsGetChannels(chat, 0n))
    } catch (e) {
      if (e instanceof RpcError && e.code === 400 || e instanceof RpcError && e.code === 406) {
        throw new HttpError(502, `The bot cannot open channel ${chat} (${e.text}). Make the bot an admin of that channel.`)
      }
      throw e
    }
    const ch = (res.chats || []).find((c) => c.id === chat)
    if (!ch || ch._ !== 'channel' || ch.accessHash === undefined) {
      throw new HttpError(502, `The bot cannot see channel ${chat}. Make the bot an admin of that channel.`)
    }
    this.channelHashes.set(chat, ch.accessHash)
    await this.o.storage.put(key, String(ch.accessHash))
    return ch.accessHash
  }

  async fileInfo(chat, msg) {
    await this.ensureAuthorized()
    let ah = await this._channelHash(chat)
    let res
    try {
      res = await this.call(this.home.dc, TL.channelsGetMessages(chat, ah, [msg]))
    } catch (e) {
      if (!(e instanceof RpcError) || !/CHANNEL_INVALID|CHANNEL_PRIVATE/.test(e.text)) throw e
      ah = await this._channelHash(chat, true)
      res = await this.call(this.home.dc, TL.channelsGetMessages(chat, ah, [msg]))
    }
    const m = res.messages && res.messages[0]
    if (!m || m._ !== 'message') throw new HttpError(404, 'This file was deleted from the channel')
    const doc = m.media && m.media._ === 'messageMediaDocument' ? m.media.document : null
    if (!doc || doc._ !== 'document') throw new HttpError(415, 'This message is not a file')
    const fn = (doc.attributes || []).find((a) => a._ === 'documentAttributeFilename')
    return {
      dc: doc.dcId,
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: new Uint8Array(doc.fileReference),
      size: Number(doc.size),
      mime: doc.mimeType || '',
      name: fn ? fn.fileName : '',
    }
  }

  // One 1 MB part. `refresh()` re-reads the message when Telegram says the file reference
  // expired (it rotates them); FILE_MIGRATE moves the download to the right DC.
  async part(info, offset, refresh) {
    for (let attempt = 0; ; attempt++) {
      const usedRef = info.fileReference
      try {
        // a part whose answer got lost on a live connection is asked again after partTimeoutMs
        const res = await this.call(info.dc, TL.uploadGetFile(info, offset, PART), { timeoutMs: this.o.partTimeoutMs || PART_TIMEOUT_MS })
        if (res._ !== 'upload.file') throw new Error('unexpected file reply ' + res._)
        return res.bytes
      } catch (e) {
        if (attempt < 3 && e instanceof RpcError && e.text.startsWith('FILE_REFERENCE_') && refresh) {
          // another part may already have refreshed the shared info object
          if (info.fileReference === usedRef) {
            const fresh = await refresh()
            info.fileReference = fresh.fileReference
            info.dc = fresh.dc
          }
          continue
        }
        if (attempt < 3 && e instanceof RpcError && e.text.startsWith('FILE_MIGRATE_') && e.value) {
          info.dc = e.value
          continue
        }
        throw e
      }
    }
  }
}
