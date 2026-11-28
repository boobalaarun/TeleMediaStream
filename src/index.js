// TeleMediaStream: streams an app's Telegram files through Cloudflare (Workers Free plan).
// Front Worker (Free plan: 10 ms CPU per request). It only checks the signed link and pipes
// bytes; all Telegram work happens in a TeleCore Durable Object (30 s CPU per request).
// One object for you (SHARED_SECRET) and one per user with their own bots (USER_SECRET_<NAME>).
import { TeleCore } from './core.js'
import { VERSION } from './config.js'
import { appUrl, locationHint, APP_URL_HELP } from './settings.js'
import { verifyLink, verifyRequest, decodeStreamId } from './links.js'
import { parseRange, fileNameAndMime, streamHeaders, text } from './http.js'
import { tenants, objectName, MAIN } from './tenants.js'
import { handleAdmin } from './admin.js'
import { relay, RETRY_DELAYS_MS } from './relay.js'

export { TeleCore }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// /dl/{token}/{id}/{name}: token is letters+digits, id is base62; the name is free text (not signed)
const DL = /^\/dl\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)\/(.*)$/

// A stub for one tenant's Durable Object; every call says whose object it is
function core(env, name) {
  const stub = env.CORE.get(env.CORE.idFromName(objectName(name)), { locationHint: locationHint(env) })
  return {
    fetch: (path, init = {}) => stub.fetch('https://core' + path, { ...init, headers: { ...(init.headers || {}), 'x-tenant': name } }),
  }
}

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function passError(res) {
  const msg = (await res.text()) || 'Streaming failed'
  return text(res.status >= 400 ? res.status : 502, msg)
}

// The first segment of a play. Cloudflare can drop the link to a Durable Object while it
// restarts or moves ("Network connection lost"); two more tries on a new stub ride that out.
async function firstSegment(env, tenant, params) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      return await core(env, tenant).fetch('/seg?' + new URLSearchParams(params))
    } catch (e) {
      lastErr = e
      if (e && e.overloaded) break // Cloudflare says not to retry an overloaded object
      console.log(`[front] could not reach the Durable Object (${e && e.message ? e.message : e}); trying again`)
      if (i < 2) await sleep(RETRY_DELAYS_MS[i])
    }
  }
  throw lastErr
}

async function handleDl(request, env, ctx, m) {
  const [, token, id, name] = m
  const url = new URL(request.url)
  const app = appUrl(env)
  if (!app) return text(500, APP_URL_HELP)
  const { list } = tenants(env)
  if (!list.length) return text(500, 'This Worker has no SHARED_SECRET (or USER_SECRET_...) set')
  // The secret that signed the link tells whose stream this is: yours or one user's
  let tenant = null
  for (const t of list) {
    if (await verifyLink(t.secret, token, id, url.searchParams.get('e'), url.searchParams.get('s'))) { tenant = t.name; break }
  }
  if (!tenant) return text(403, 'Link expired or not signed for this Worker. Open the title again in your player.')
  let d
  try { d = await decodeStreamId(id) } catch { return text(400, 'Bad file id') }

  // Split files, zip parts and search results are streamed by the app itself
  if (d.parts || d.global || d.zip) return Response.redirect(`${app}/dl/${token}/${id}/${name}`, 302)

  const chat = Number(d.chat_id), msg = Number(d.msg_id)
  if (!chat || !msg) return text(400, 'Bad file id')
  const stub = core(env, tenant)
  const range = request.headers.get('range') || ''

  if (request.method === 'HEAD') {
    const r = await stub.fetch(`/info?chat=${chat}&msg=${msg}`)
    if (!r.ok) return passError(r)
    const info = await r.json()
    const pr = parseRange(range, info.size)
    if (!pr) return text(416, 'Range not satisfiable', { 'Content-Range': `bytes */${info.size}` })
    return new Response(null, { status: range ? 206 : 200, headers: streamHeaders(fileNameAndMime(info, name), pr.start, pr.end, info.size, !!range) })
  }

  const base = {
    chat: String(chat), msg: String(msg), token, file: id, name,
    ip: request.headers.get('cf-connecting-ip') || '', ua: (request.headers.get('user-agent') || '').slice(0, 200),
  }
  let first
  try {
    first = await firstSegment(env, tenant, { ...base, range, first: '1' })
  } catch (e) {
    return text(503, `The Worker could not reach its Durable Object: ${e && e.message ? e.message : e}`, { 'Retry-After': '2' })
  }
  if (first.status === 416) {
    return text(416, 'Range not satisfiable', { 'Content-Range': `bytes */${first.headers.get('x-size')}` })
  }
  if (!first.ok) return passError(first)

  const size = Number(first.headers.get('x-size'))
  const start = Number(first.headers.get('x-start'))
  const end = Number(first.headers.get('x-end'))
  const info = { mime: first.headers.get('x-mime') || '', name: decodeURIComponent(first.headers.get('x-name') || '') }
  const out = new FixedLengthStream(end - start + 1)

  // Segment after segment; after a dropped link, the rest again from the next byte (relay.js).
  // Each call gets a new stub: Cloudflare says a stub that failed this way fails again at once.
  const nextSegment = (from, to, resumed) => core(env, tenant).fetch('/seg?' + new URLSearchParams({
    ...base, start: String(from), end: String(to), ...(resumed ? { resume: resumed } : {}),
  }))
  ctx.waitUntil(
    relay({ first, start, end, nextSegment, writable: out.writable, sleep, log: (m) => console.log('[front] ' + m) })
      .catch((e) => console.log('[front] stream relay failed: ' + (e && e.stack ? e.stack : e))),
  )
  return new Response(out.readable, {
    status: range ? 206 : 200,
    headers: streamHeaders(fileNameAndMime(info, name), start, end, size, !!range),
  })
}

async function proxyJson(stubCall) {
  let r
  try {
    r = await stubCall()
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e && e.message ? e.message : e) }, 502)
  }
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const method = request.method

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    const m = DL.exec(url.pathname)
    if (m && (method === 'GET' || method === 'HEAD')) return handleDl(request, env, ctx, m)

    // The app asks the Worker to reload bot settings after you (or a user) change them;
    // the secret that signed the call says whose settings changed
    if (url.pathname === '/api/sync' && method === 'POST') {
      const body = await request.text()
      const ts = request.headers.get('x-cf-time'), sig = request.headers.get('x-cf-sig')
      let tenant = null
      for (const t of tenants(env).list) {
        if (await verifyRequest(t.secret, 'POST', '/api/sync', body, ts, sig)) { tenant = t.name; break }
      }
      if (!tenant) return jsonResponse({ error: 'Bad signature' }, 401)
      const r = await core(env, tenant).fetch('/sync', { method: 'POST' })
      return jsonResponse({ ok: r.ok }, r.ok ? 200 : 502)
    }

    // The dashboard: /admin (the page) and /admin/api/* (calls signed with your secret)
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(request, env, url, core)

    // /status: you; /status/<name>: one user (no secrets, file names or viewer IPs in either)
    if (method === 'GET' && (url.pathname === '/status' || url.pathname.startsWith('/status/'))) {
      const { list, ignored } = tenants(env)
      const want = url.pathname === '/status' ? MAIN : decodeURIComponent(url.pathname.slice(8)).toLowerCase()
      if (!list.some((t) => t.name === want)) {
        return jsonResponse({ ok: false, error: want === MAIN ? 'SHARED_SECRET is not set' : 'No such user on this Worker' }, 404)
      }
      if (want !== MAIN) return proxyJson(() => core(env, want).fetch('/status'))
      let r
      try {
        r = await core(env, MAIN).fetch('/status')
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e && e.message ? e.message : e) }, 502)
      }
      const body = await r.json().catch(() => ({ ok: false }))
      body.users = list.length - 1
      if (ignored) body.ignoredUserSecrets = ignored
      return jsonResponse(body, r.status)
    }

    if (url.pathname === '/selftest' && method === 'GET') {
      const { list } = tenants(env)
      return proxyJson(() => core(env, list.length ? list[0].name : MAIN).fetch('/selftest'))
    }

    if (url.pathname === '/' && (method === 'GET' || method === 'HEAD')) {
      // A browser gets the dashboard; scripts and health checks get one line of text
      if (method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
        return Response.redirect(new URL('/admin', url).href, 302)
      }
      const app = appUrl(env)
      if (!app) return text(500, `telemediastream ${VERSION}: ${APP_URL_HELP}`)
      return text(200, `telemediastream ${VERSION}: OK (serves ${new URL(app).host} only)`)
    }
    return text(404, 'Not found')
  },
}
