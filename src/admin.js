// The dashboard at /admin. The page signs every API call with the secret typed into it
// (x-admin-time / x-admin-sig, the same HMAC scheme the app uses), so the secret never travels.
// SHARED_SECRET sees every bot on this Worker; a USER_SECRET_<NAME> sees only that user's.
import PAGE from './admin.html'
import { VERSION } from './config.js'
import { appUrl, APP_URL_HELP } from './settings.js'
import { verifyRequest } from './links.js'
import { tenants, MAIN } from './tenants.js'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
})

function page(env) {
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const app = appUrl(env)
  const html = PAGE
    .replaceAll('{{NONCE}}', nonce)
    .replaceAll('{{VERSION}}', esc(VERSION))
    .replaceAll('{{HOST}}', app ? esc(new URL(app).host) : '')
    .replaceAll('{{PROBLEM}}', app ? '' : esc(APP_URL_HELP))
    .replaceAll('{{NOW}}', String(Date.now()))
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
        `connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// The tenants this request may see: all of them for SHARED_SECRET, one for a user's secret
async function scopeOf(request, env, path, body) {
  const ts = request.headers.get('x-admin-time'), sig = request.headers.get('x-admin-sig')
  if (!ts || !sig) return null
  const { list } = tenants(env)
  for (const t of list) {
    if (await verifyRequest(t.secret, request.method, path, body, ts, sig)) {
      return t.name === MAIN ? list.map((x) => x.name) : [t.name]
    }
  }
  return null
}

async function call(core, env, name, path, init) {
  try {
    const r = await core(env, name).fetch(path, init)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    if (!r.ok || !body) return { name, error: (body && body.error) || text.slice(0, 300) || `HTTP ${r.status}` }
    return { ...body, name }
  } catch (e) {
    return { name, error: String(e && e.message ? e.message : e) }
  }
}

async function state(env, core, scope) {
  const app = appUrl(env)
  const clients = await Promise.all(scope.map((name) => call(core, env, name, '/admin')))
  // Each object counted its own hours; line them up on the newest hour and add them
  const firstHour = Math.max(...clients.map((c) => (Array.isArray(c.hours) ? c.firstHour : -Infinity)))
  const hours = new Array(24).fill(0)
  let today = 0
  for (const c of clients) {
    if (!Array.isArray(c.hours)) continue
    today += c.today || 0
    c.hours.forEach((n, i) => {
      const at = c.firstHour + i - firstHour
      if (at >= 0 && at < 24) hours[at] += n
    })
  }
  return json({
    version: VERSION, app: app ? new URL(app).host : null, all: scope.includes(MAIN), clients, today,
    hours: Number.isFinite(firstHour) ? hours : null, firstHour: Number.isFinite(firstHour) ? firstHour : null,
  })
}

async function sync(env, core, scope) {
  const results = await Promise.all(scope.map((name) => call(core, env, name, '/sync', { method: 'POST' })))
  return json({ ok: results.every((r) => !r.error), results: results.map((r) => ({ name: r.name, error: r.error || null })) })
}

async function selftest(env, core, scope) {
  const r = await call(core, env, scope[0], '/selftest')
  return json(r, r.error ? 502 : 200)
}

const API = { 'GET /admin/api/state': state, 'POST /admin/api/sync': sync, 'POST /admin/api/selftest': selftest }

export async function handleAdmin(request, env, url, core) {
  const path = url.pathname
  if (path === '/admin' || path === '/admin/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405)
    return page(env)
  }
  const handler = API[request.method + ' ' + path]
  if (!handler) return json({ error: 'Not found' }, 404)
  const body = request.method === 'POST' ? await request.text() : ''
  const scope = await scopeOf(request, env, path, body)
  if (!scope) return json({ error: 'Wrong secret' }, 401)
  if (!scope.length) return json({ error: 'This Worker has no SHARED_SECRET set' }, 500)
  return handler(env, core, scope)
}
