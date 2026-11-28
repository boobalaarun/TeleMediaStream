// TeleCore: the Durable Object that talks to Telegram. A Durable Object gets 30 s of CPU per
// incoming request (a plain Worker gets 10 ms on the Free plan), which is what makes MTProto
// decryption possible on the Free plan. One object serves all of your (main) streams and one
// serves each user who streams with their own bots. Each object counts toward the account's
// 13,000 GB-s/day only while it is active (~450 GB-s per hour of streaming).
import { connect } from 'cloudflare:sockets'
import simdWasm from './vendor/mtcute-simd.wasm'
import scalarWasm from './vendor/mtcute.wasm'
import { initCrypto, igeDecrypt } from './mtproto/crypto.js'
import { TelegramClient, HttpError, PART } from './telegram.js'
import { signRequest } from './links.js'
import { parseRange } from './http.js'
import { MAIN, secretFor, secretKey, memberName } from './tenants.js'
import {
  DC_ADDRS, RSA_KEYS, DH_PRIME_OVERRIDE, SEGMENT_BYTES, PREFETCH, CONFIG_TTL_MS, REPORT_EVERY_MS, VERSION,
} from './config.js'
import { appUrl, APP_URL_HELP } from './settings.js'
import { addBytes, mergeHours, summarize } from './stats.js'
import { Health, healthLines, explainError, waitPct } from './health.js'

const FILE_TTL_MS = 6 * 3600 * 1000
const STREAM_IDLE_MS = 30000
const HEALTH_SAVE_MS = 15000

// A stream's average speed and how much of its time went on waiting for Telegram (public: no names)
const streamFigures = (s, now) => {
  const secs = Math.max(1, ((s.active > 0 ? now : s.last) - s.since) / 1000)
  return { mbps: Math.round((s.bytes * 8) / secs / 1e5) / 10, telegramWaitPct: waitPct(s.telegramWaitMs || 0, s.playerWaitMs || 0) }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

export class TeleCore {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    initCrypto([simdWasm, scalarWasm])
    this.cfg = null
    this.cfgLoading = null
    this.files = new Map()
    this.refreshing = new Map()
    this.streams = new Map()
    this.usage = {}
    this.starts = []
    this.reportTimer = null
    this.lastError = ''
    this.hourBytes = {} // bytes per UTC hour not yet saved (see flushStats)
    this.statsChain = Promise.resolve()
    this.syncedAt = 0 // last time the app's settings were fetched
    this.tenant = null // 'main' (your bots) or a user's name; set by the front Worker's x-tenant header
    this.health = new Health() // today's slow-downs, dropped links and Free-plan use (health.js)
    this.healthLoaded = null
    this.healthTimer = null
    this.tg = new TelegramClient({
      connect,
      storage: ctx.storage,
      dcAddrs: DC_ADDRS,
      rsaKeys: RSA_KEYS,
      dhPrime: DH_PRIME_OVERRIDE,
      getAppConfig: () => this.appConfig(),
      log: (m) => console.log('[tg] ' + m),
      onFlood: (f) => {
        this.health.slowdown(f)
        console.log(`[tg] Telegram asked the bot to wait ${f.seconds} s (${f.text}, DC ${f.dc})${f.waited ? '; waiting it out' : '; too long, this request stops'}`)
        this.saveHealthSoon()
      },
    })
  }

  // ---------- health counters (kept across restarts for the day) ----------
  loadHealth() {
    if (!this.healthLoaded) {
      this.healthLoaded = this.ctx.storage.get('health')
        .then((saved) => this.health.load(saved))
        .catch(() => { this.healthLoaded = null })
    }
    return this.healthLoaded
  }

  saveHealthSoon() {
    if (this.healthTimer) return
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null
      this.saveHealth().catch((e) => console.log('[core] health not saved: ' + e.message))
    }, HEALTH_SAVE_MS)
  }

  async saveHealth() {
    if (!this.health.dirty) return
    this.health.dirty = false
    await this.ctx.storage.put('health', this.health.saved())
  }

  healthReport() {
    const h = this.health.snapshot()
    return { health: h, summary: healthLines(h) }
  }

  // ---------- settings from the app ----------
  async appConfig(force = false) {
    if (!force && this.cfg && Date.now() - this.cfg.at < CONFIG_TTL_MS) return this.cfg
    if (this.cfgLoading) return this.cfgLoading
    this.cfgLoading = (async () => {
      try {
        const cfg = await this._fetchAppConfig()
        this.cfg = cfg
        this.syncedAt = Date.now()
        await this.ctx.storage.put('appcfg', { apiId: cfg.apiId, apiHash: cfg.apiHash, bots: cfg.bots })
        return cfg
      } catch (e) {
        // App unreachable: keep streaming with the last known settings
        if (!(e instanceof HttpError)) {
          const saved = this.cfg || (await this.ctx.storage.get('appcfg'))
          if (saved) {
            this.cfg = { ...saved, at: Date.now() - CONFIG_TTL_MS + 60000 }
            return this.cfg
          }
        }
        throw e
      } finally {
        this.cfgLoading = null
      }
    })()
    return this.cfgLoading
  }

  get isMain() {
    return (this.tenant || MAIN) === MAIN
  }

  // The secret this object signs with: SHARED_SECRET for you, USER_SECRET_<NAME> for a user
  secret() {
    return secretFor(this.env, this.tenant || MAIN)
  }

  async _fetchAppConfig() {
    const secret = this.secret()
    const key = secretKey(this.tenant || MAIN)
    if (!secret) throw new HttpError(500, `${key} is not set on this Worker`)
    const app = appUrl(this.env)
    if (!app) throw new HttpError(500, APP_URL_HELP)
    const path = '/api/cf/config'
    const res = await fetch(app + path, {
      headers: { ...(await signRequest(secret, 'GET', path, '')), 'user-agent': 'telemediastream/' + VERSION },
    })
    if (res.status === 401) {
      throw new HttpError(502, this.isMain
        ? `The app rejected this Worker: SHARED_SECRET must equal the Cloudflare secret in the app (on someone else's app: the secret its owner entered for your account)`
        : `The app rejected user "${this.tenant}": the secret the app has for this user must equal ${key} here`)
    }
    if (!res.ok) throw new Error(`The app's /api/cf/config answered HTTP ${res.status}`)
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('json')) throw new Error('The app did not return JSON from /api/cf/config (is APP_URL the address of the app?)')
    const d = await res.json()
    const bots = (d.bots || []).filter(Boolean)
    if (!d.api_id || !d.api_hash) throw new HttpError(502, 'The app returned no API id/hash')
    if (!bots.length) {
      throw new HttpError(502, this.isMain
        ? `The app returned no bot token (on someone else's app: your own bots are off or not verified yet)`
        : `The app returned no bots for user "${this.tenant}" (their own bots are off or not verified yet)`)
    }
    return { apiId: Number(d.api_id), apiHash: String(d.api_hash), bots, at: Date.now() }
  }

  // ---------- file info ----------
  async fileInfo(chat, msg, refresh = false) {
    const key = chat + ':' + msg
    const hit = this.files.get(key)
    if (!refresh && hit && Date.now() - hit.at < FILE_TTL_MS) return hit.info
    const info = await this.tg.fileInfo(chat, msg)
    this.files.set(key, { info, at: Date.now() })
    if (this.files.size > 500) this.files.delete(this.files.keys().next().value)
    return info
  }

  part(chat, msg, info, offset) {
    return this.tg.part(info, offset, () => this.refreshInfo(chat, msg))
  }

  // Several in-flight parts can hit an expired file reference at once: re-read the message once
  refreshInfo(chat, msg) {
    const key = chat + ':' + msg
    let p = this.refreshing.get(key)
    if (!p) {
      p = this.fileInfo(chat, msg, true).finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, p)
    }
    return p
  }

  // ---------- HTTP entry (called by the front Worker only) ----------
  async fetch(request) {
    const url = new URL(request.url)
    // Each object belongs to one tenant: its id is derived from the same name (see tenants.js)
    if (!this.tenant) this.tenant = request.headers.get('x-tenant') || MAIN
    await this.loadHealth()
    this.health.request()
    this.health.enter() // a stream keeps the object busy longer: segment() enters again for it
    this.saveHealthSoon()
    try {
      switch (url.pathname) {
        case '/seg':
          // the front Worker asks again for a next segment after Cloudflare dropped its link here
          if (url.searchParams.get('resume') === 'link') this.health.drop()
          return await this.segment(url.searchParams)
        case '/info': {
          const info = await this.fileInfo(Number(url.searchParams.get('chat')), Number(url.searchParams.get('msg')))
          return json({ size: info.size, mime: info.mime, name: info.name, dc: info.dc })
        }
        case '/sync':
          this.cfg = null
          this.files.clear()
          await this.appConfig(true)
          return json({ ok: true })
        case '/status': return json(await this.status())
        case '/selftest': return json(this.selftest())
        case '/admin': return json(await this.adminState())
        default: return new Response('not found', { status: 404 })
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502
      this.lastError = String(e && e.message ? e.message : e).slice(0, 300)
      console.log('[core] error: ' + this.lastError)
      return new Response(this.lastError, { status, headers: { 'x-error': '1' } })
    } finally {
      this.health.leave()
    }
  }

  async status() {
    let config = 'not loaded', bot = 'not logged in'
    try { await this.appConfig(); config = 'ok' } catch (e) { config = String(e.message || e) }
    try { await this.tg._load(); if (this.tg.home) bot = 'logged in (DC ' + this.tg.home.dc + ')' } catch {}
    const dcs = [...this.tg.dc.entries()].filter(([, s]) => s.authorized).map(([d]) => d)
    const now = Date.now()
    const live = [...this.streams.values()].filter((s) => s.active > 0)
    return {
      ok: config === 'ok', version: VERSION, app: appUrl(this.env) ? new URL(appUrl(this.env)).host : null,
      ...(this.isMain ? {} : { user: this.tenant }),
      config, bot, authorizedDcs: dcs,
      activeStreams: live.length,
      // no names or viewer IPs here: /status is public
      streams: live.map((s) => ({
        dc: s.info ? s.info.dc : null,
        mb: Math.round(s.bytes / 1048576),
        seconds: Math.round((now - s.since) / 1000),
        idleSeconds: Math.round((now - s.last) / 1000),
        ...streamFigures(s, now),
      })),
      connections: this.tg.connectionCounts(),
      lastError: this.lastError || null,
      lastErrorExplained: explainError(this.lastError),
      ...this.healthReport(),
    }
  }

  // Proves the Durable Object CPU budget on the real account: decrypts 128 MB with AES-256-IGE
  // in this one request (~0.8 s CPU). A plain Free Worker would be stopped after 10 ms.
  selftest() {
    if (this.lastSelftest && Date.now() - this.lastSelftest < 60000) {
      return { ok: true, cached: true, note: 'already passed in the last minute' }
    }
    const block = new Uint8Array(PART)
    crypto.getRandomValues(block.subarray(0, 65536))
    const key = new Uint8Array(32), iv = new Uint8Array(32)
    let x = 0
    for (let i = 0; i < 128; i++) x ^= igeDecrypt(block, key, iv)[i]
    this.lastSelftest = Date.now()
    return {
      ok: true, decryptedMB: 128, check: x,
      note: 'Durable Object finished ~0.8 s of CPU work in one request; streaming needs ~7 ms per MB',
      segmentMB: this.segmentBytes() / 1048576,
    }
  }

  segmentBytes() {
    const mb = Number(this.env.SEGMENT_MB)
    return mb > 0 ? Math.floor(mb * 1048576) : SEGMENT_BYTES
  }

  async segment(q) {
    const chat = Number(q.get('chat')), msg = Number(q.get('msg'))
    if (!chat || !msg) throw new HttpError(400, 'bad request')
    const info = await this.fileInfo(chat, msg)
    const size = info.size
    let start, end
    if (q.has('start')) {
      start = Number(q.get('start'))
      end = Number(q.get('end'))
      if (!(start >= 0 && end >= start && end < size)) throw new HttpError(416, 'bad segment')
    } else {
      const r = parseRange(q.get('range') || '', size)
      if (!r) return new Response('range not satisfiable', { status: 416, headers: { 'x-size': String(size) } })
      ;({ start, end } = r)
    }
    const segEnd = Math.min(end, start + this.segmentBytes() - 1)

    const stream = this.trackStream(q, info, chat, msg)
    const { readable, writable } = new IdentityTransformStream()
    const writer = writable.getWriter()
    const done = this.pump(chat, msg, info, start, segEnd, writer, stream, q.get('token') || '')
    this.ctx.waitUntil(done)
    return new Response(readable, {
      headers: {
        'x-size': String(size), 'x-start': String(start), 'x-end': String(end), 'x-seg-end': String(segEnd),
        'x-mime': info.mime || '', 'x-name': encodeURIComponent(info.name || ''), 'x-dc': String(info.dc),
      },
    })
  }

  async pump(chat, msg, info, start, last, writer, stream, token) {
    stream.active++
    this.health.enter()
    const queue = []
    let next = start - (start % PART)
    const fill = () => {
      while (queue.length < PREFETCH && next <= last) {
        const off = next
        const p = this.part(chat, msg, info, off)
        p.catch(() => {})
        queue.push({ off, p })
        next += PART
      }
    }
    let clientGone = false
    try {
      fill()
      let pos = start
      while (pos <= last) {
        const { off, p } = queue.shift()
        const t0 = Date.now()
        const data = await p
        const telegramMs = Date.now() - t0 // the part wasn't here yet: waiting for Telegram
        fill()
        const from = pos - off
        const to = Math.min(data.length, last - off + 1)
        if (to <= from) throw new Error('Telegram returned less data than the file size')
        const piece = data.subarray(from, to)
        const t1 = Date.now()
        try {
          await writer.write(piece)
        } catch {
          clientGone = true // player closed the connection or seeked: not an error
          break
        }
        const playerMs = Date.now() - t1 // waiting for the player (through the front Worker) to take it
        const n = piece.length
        pos = off + to
        stream.bytes += n
        stream.last = Date.now()
        stream.telegramWaitMs = (stream.telegramWaitMs || 0) + telegramMs
        stream.playerWaitMs = (stream.playerWaitMs || 0) + playerMs
        this.health.waits({ telegramMs, playerMs, bytes: n })
        addBytes(this.hourBytes, n)
        this.usage[token] = (this.usage[token] || 0) + n
        this.scheduleReport()
      }
      if (!clientGone) await writer.close()
    } catch (e) {
      const m = String(e && e.message ? e.message : e)
      this.lastError = m.slice(0, 300)
      console.log('[core] stream error: ' + m)
      try { await writer.abort(e) } catch {}
    } finally {
      stream.active--
      stream.last = Date.now()
      this.health.leave()
      this.saveHealthSoon()
      this.scheduleReport()
    }
  }

  // ---------- dashboard (/admin; the front Worker checks the secret first) ----------
  // Saves the bytes counted since the last save; one save at a time so none is lost
  flushStats() {
    this.statsChain = this.statsChain.catch(() => {}).then(async () => {
      const pending = this.hourBytes
      if (!Object.keys(pending).length) return
      this.hourBytes = {}
      try {
        const saved = (await this.ctx.storage.get('hourly')) || {}
        await this.ctx.storage.put('hourly', mergeHours(saved, pending))
      } catch (e) {
        mergeHours(this.hourBytes, pending)
        throw e
      }
    })
    return this.statsChain
  }

  async adminState() {
    let config = 'not loaded'
    try { await this.appConfig(); config = 'ok' } catch (e) { config = String(e && e.message ? e.message : e) }
    try { await this.tg._load() } catch {}
    await this.flushStats().catch(() => {})
    const now = Date.now()
    const { today, hours, firstHour } = summarize((await this.ctx.storage.get('hourly')) || {}, now)
    // streams that are playing, or stopped in the last 15 s
    const live = [...this.streams.values()].filter((s) => s.active > 0 || now - s.last < 15000)
    return {
      name: this.tenant || MAIN,
      version: VERSION,
      config,
      syncedAgo: this.syncedAt ? Math.round((now - this.syncedAt) / 1000) : null,
      bot: this.tg.home ? { dc: this.tg.home.dc } : null,
      connections: this.tg.connectionCounts(),
      streams: live.map((s) => ({
        id: s.id, name: s.name, dc: s.info ? s.info.dc : null, bytes: s.bytes, playing: s.active > 0,
        seconds: Math.round((now - s.since) / 1000), idleSeconds: Math.round((now - s.last) / 1000),
        ...streamFigures(s, now),
      })),
      today, hours, firstHour,
      lastError: this.lastError || null,
      lastErrorExplained: explainError(this.lastError),
      ...this.healthReport(),
    }
  }

  // ---------- usage + live streams for the app's dashboard ----------
  trackStream(q, info, chat, msg) {
    const token = q.get('token') || ''
    const ip = q.get('ip') || ''
    const key = `${token}|${chat}|${msg}|${ip}`
    let s = this.streams.get(key)
    if (!s) {
      s = {
        id: crypto.randomUUID().slice(0, 12), token, chat, msg, file: q.get('file') || '',
        name: info.name || decodeURIComponent(q.get('name') || ''), ip, bytes: 0, since: Date.now(), last: Date.now(), active: 0,
      }
      this.streams.set(key, s)
    }
    s.info = info // for /status: which DC the file is on
    if (q.get('first') === '1') this.starts.push({ token, ip, ua: q.get('ua') || '' })
    return s
  }

  scheduleReport() {
    if (this.reportTimer) return
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null
      this.report().catch((e) => console.log('[core] usage report failed: ' + e.message))
    }, REPORT_EVERY_MS)
  }

  async report() {
    await this.flushStats().catch((e) => console.log('[core] stats not saved: ' + e.message))
    await this.saveHealth().catch((e) => console.log('[core] health not saved: ' + e.message))
    const now = Date.now()
    for (const [k, s] of this.streams) if (s.active === 0 && now - s.last > STREAM_IDLE_MS) this.streams.delete(k)
    const usage = this.usage
    const starts = this.starts
    this.usage = {}
    this.starts = []
    const streams = [...this.streams.values()].map((s) => ({
      id: s.id, token: s.token, msg: s.msg, chat: s.chat, file: s.file, name: s.name, ip: s.ip, bytes: s.bytes, since: s.since, last: s.last,
    }))
    const body = JSON.stringify({
      usage: Object.fromEntries(Object.entries(usage).filter(([t, n]) => t && n > 0)),
      starts, member: memberName(this.tenant || MAIN, this.ctx.id), client_index: null, dc: this.tg.home ? this.tg.home.dc : null, streams,
    })
    const path = '/api/cf/usage'
    try {
      const secret = this.secret()
      if (!secret) throw new Error(`${secretKey(this.tenant || MAIN)} is no longer set`)
      const app = appUrl(this.env)
      if (!app) throw new Error('APP_URL is not set')
      const res = await fetch(app + path, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', ...(await signRequest(secret, 'POST', path, body)) },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
    } catch (e) {
      // keep the counts for the next report so the app's quotas stay right
      for (const [t, n] of Object.entries(usage)) this.usage[t] = (this.usage[t] || 0) + n
      if (this.starts.length < 200) this.starts.push(...starts)
      throw e
    } finally {
      if (this.streams.size || Object.keys(this.usage).length) this.scheduleReport()
    }
  }
}
