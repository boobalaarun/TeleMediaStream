// End-to-end: the real Worker + Durable Object running in workerd (wrangler dev --local),
// fake multi-DC Telegram (Node), fake app (Python, with the app's real signature code).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { initTestCrypto, assert } from './shims.mjs'
import { World, fileBytes } from './fake-telegram.mjs'
import * as B from '../src/mtproto/bytes.js'

initTestCrypto()
const here = new URL('.', import.meta.url).pathname
const root = new URL('..', import.meta.url).pathname
const py = (...a) => execFileSync('python3', [here + 'app_ref.py', ...a], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const world = new World({ expireRefAfter: 7 })
const ports = await world.start()
const SECRET = 'e2e' + randomBytes(16).toString('hex')
const SECRET_ALICE = 'alice' + randomBytes(16).toString('hex') // a user streaming with their own bot
const TOKEN = 'CurrFtBwIfmWmqbNcnpyAzCOClS7F2gj'
const APP_PORT = 18099, WORKER_PORT = 18787
const W = `http://127.0.0.1:${WORKER_PORT}`
const APP = `http://127.0.0.1:${APP_PORT}`
const children = []
let passed = 0
const ok = (n) => { passed++; console.log('  ok  ' + n) }

function startApp() {
  const p = spawn('python3', [here + 'fake_app.py', String(APP_PORT), SECRET, String(world.apiId), world.apiHash, '111:AAA-test-token',
    `alice=${SECRET_ALICE}=222:BBB-other`], { stdio: 'inherit' })
  children.push(p)
  return p
}

async function waitFor(url, ms) {
  const until = Date.now() + ms
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return r } catch {}
    if (Date.now() > until) throw new Error('timeout waiting for ' + url)
    await sleep(300)
  }
}

const hex16 = (b) => b.toString(16).padStart(16, '0')
const overrides = {
  dcs: Object.fromEntries(Object.entries(ports).map(([dc, p]) => [dc, ['127.0.0.1', p]])),
  rsa: [{ fp: hex16(world.rsa.fp), n: world.rsa.n.toString(16), e: world.rsa.e.toString(16) }],
  segmentBytes: 2 * 1048576 + 4096,
  reportEveryMs: 1000,
}
const dir = here + '.e2e/'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(dir + 'wrangler.toml', `name = "telemediastream-e2e"
main = "../../src/index.js"
compatibility_date = "2026-10-01"

[define]
__TEST_OVERRIDES__ = ${JSON.stringify(JSON.stringify(overrides))}

[vars]
APP_URL = "${APP}/"
SHARED_SECRET = "${SECRET}"
USER_SECRET_ALICE = "${SECRET_ALICE}"
USER_SECRET_DUP = "${SECRET}"

[[durable_objects.bindings]]
name = "CORE"
class_name = "TeleCore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TeleCore"]
`)

const link = (payload, name = 'video.mkv') => py('link', SECRET, W, TOKEN, py('encode', JSON.stringify(payload)), name)
const fileLink = (msg) => link({ chat_id: world.channelId, msg_id: msg })
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer())

try {
  startApp()
  await waitFor(APP + '/_reports', 15000)
  const wr = spawn('npx', ['wrangler', 'dev', '--config', dir + 'wrangler.toml', '--port', String(WORKER_PORT), '--ip', '127.0.0.1',
    '--local', '--persist-to', dir + 'state', '--log-level', 'info', '--inspector-port', '0'],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(wr)
  const wlog = []
  wr.stdout.on('data', (d) => wlog.push(String(d)))
  wr.stderr.on('data', (d) => wlog.push(String(d)))
  try { await waitFor(W + '/', 90000) } catch (e) { console.log(wlog.join('')); throw e }

  // 0. health
  {
    const r = await fetch(W + '/')
    assert(r.status === 200 && (await r.text()).includes('127.0.0.1:' + APP_PORT), 'health text names the app it serves')
    ok('GET / answers and names the only app it serves')
  }

  const f11 = world.files.get(11), f12 = world.files.get(12)
  const all11 = fileBytes(11, 0, f11.size), all12 = fileBytes(12, 0, f12.size)

  // 1. first play: full file, no Range (bot login, DC migration, auth export happen here)
  {
    const t = Date.now()
    const r = await fetch(fileLink(11))
    const body = await bytesOf(r)
    assert(r.status === 200, 'status 200, got ' + r.status + ' ' + new TextDecoder().decode(body.subarray(0, 300)))
    assert(r.headers.get('content-length') === String(f11.size), 'content-length')
    assert(r.headers.get('content-type') === 'video/x-matroska', 'content-type')
    assert(r.headers.get('accept-ranges') === 'bytes', 'accept-ranges')
    assert((r.headers.get('content-disposition') || '').includes('Arinthum'), 'file name from Telegram')
    assert(B.equal(body, all11), 'full body matches Telegram file')
    ok(`first play: whole ${(f11.size / 1048576).toFixed(2)} MB file correct in ${Date.now() - t} ms (login + DC4 + DC5 export/import)`)
  }

  // 2. ranges like a player seeking
  {
    const cases = [[1048000, 3000000], [0, 0], [f11.size - 1, f11.size - 1], [5 * 1048576, f11.size - 1]]
    for (const [a, b] of cases) {
      const r = await fetch(fileLink(11), { headers: { Range: `bytes=${a}-${b}` } })
      const body = await bytesOf(r)
      assert(r.status === 206, `206 for ${a}-${b}`)
      assert(r.headers.get('content-range') === `bytes ${a}-${b}/${f11.size}`, 'content-range ' + r.headers.get('content-range'))
      assert(B.equal(body, all11.subarray(a, b + 1)), `bytes ${a}-${b}`)
    }
    const r = await fetch(fileLink(11), { headers: { Range: 'bytes=-1000' } })
    assert(r.status === 206 && B.equal(await bytesOf(r), all11.subarray(f11.size - 1000)), 'suffix range')
    const r2 = await fetch(fileLink(11), { headers: { Range: 'bytes=3000000-' } })
    assert(r2.status === 206 && B.equal(await bytesOf(r2), all11.subarray(3000000)), 'open range')
    ok('seeking: byte ranges across 1 MB part boundaries, suffix and open ranges are exact')
  }

  // 3. long range chained over several Durable Object segments (2 MB segments in this test)
  {
    const r = await fetch(fileLink(12), { headers: { Range: 'bytes=777-' } })
    const body = await bytesOf(r)
    assert(r.status === 206 && body.length === f12.size - 777, 'length over segments')
    assert(B.equal(body, all12.subarray(777)), '9 MB over 5 segments')
    ok(`a ${(body.length / 1048576).toFixed(2)} MB response stitched from 5 Durable Object segments is exact`)
  }

  // 4. three viewers at once
  {
    const t = Date.now()
    const rs = await Promise.all([
      fetch(fileLink(11)).then(bytesOf),
      fetch(fileLink(12)).then(bytesOf),
      fetch(fileLink(12), { headers: { Range: 'bytes=4000000-8000000' } }).then(bytesOf),
    ])
    assert(B.equal(rs[0], all11) && B.equal(rs[1], all12) && B.equal(rs[2], all12.subarray(4000000, 8000001)), 'parallel bodies')
    ok(`three simultaneous streams all exact (${Date.now() - t} ms)`)
  }

  // 5. HEAD, 416, bad links, redirects
  {
    const h = await fetch(fileLink(12), { method: 'HEAD', headers: { Range: 'bytes=0-99' } })
    assert(h.status === 206 && h.headers.get('content-length') === '100' && h.headers.get('content-range') === `bytes 0-99/${f12.size}`, 'HEAD range')
    const r416 = await fetch(fileLink(11), { headers: { Range: `bytes=${f11.size}-` } })
    assert(r416.status === 416 && r416.headers.get('content-range') === `bytes */${f11.size}`, '416')
    const good = new URL(fileLink(11))
    const bad = new URL(good); bad.searchParams.set('s', '0'.repeat(32))
    assert((await fetch(bad)).status === 403, 'bad signature -> 403')
    const other = new URL(py('link', 'some-other-apps-secret', W, TOKEN, good.pathname.split('/')[3], 'video.mkv'))
    assert((await fetch(other)).status === 403, 'link from another app -> 403')
    const split = await fetch(link({ parts: [{ chat_id: world.channelId, msg_id: 11 }, { chat_id: world.channelId, msg_id: 12 }] }), { redirect: 'manual' })
    assert(split.status === 302 && split.headers.get('location').startsWith(APP + '/dl/' + TOKEN + '/'), 'split -> app')
    const gone = await fetch(fileLink(99))
    assert(gone.status === 404, 'deleted message -> 404, got ' + gone.status)
    ok('HEAD, 416, forged/foreign links (403), split files (302 to the app), deleted file (404)')
  }

  // 6. viewer stops mid-stream: Worker stops pulling from Telegram
  {
    const ac = new AbortController()
    const r = await fetch(fileLink(12), { signal: ac.signal })
    const reader = r.body.getReader()
    await reader.read()
    ac.abort()
    await sleep(1500)
    const calls = world.getFileCalls
    await sleep(2000)
    assert(world.getFileCalls - calls <= 1, `still downloading after viewer left (${world.getFileCalls - calls} parts)`)
    ok('when the viewer stops, Telegram downloads stop')
  }

  // 7. /api/sync from the app, status page
  {
    const before = (await (await fetch(APP + '/_reports')).json()).config_calls
    const [ts, sig] = py('sync', SECRET).split(' ')
    const s = await fetch(W + '/api/sync', { method: 'POST', body: '{}', headers: { 'x-cf-time': ts, 'x-cf-sig': sig, 'content-type': 'application/json' } })
    assert(s.status === 200 && (await s.json()).ok === true, 'signed sync accepted')
    const after = (await (await fetch(APP + '/_reports')).json()).config_calls
    assert(after === before + 1, 'sync re-read bot settings from the app')
    const u = await fetch(W + '/api/sync', { method: 'POST', body: '{}' })
    assert(u.status === 401, 'unsigned sync rejected')
    const st = await (await fetch(W + '/status')).json()
    assert(st.ok && st.bot === 'logged in (DC 4)' && st.authorizedDcs.includes(5), 'status ' + JSON.stringify(st))
    const self = await (await fetch(W + '/selftest')).json()
    assert(self.ok && self.decryptedMB === 128, 'selftest ' + JSON.stringify(self))
    ok("the app's /api/sync reloads settings (unsigned: 401); /status and /selftest report OK")
  }

  // 8. usage and live streams reported to the app's dashboard
  {
    await sleep(2500)
    const { reports } = await (await fetch(APP + '/_reports')).json()
    const bytes = reports.reduce((n, r) => n + ((r.usage || {})[TOKEN] || 0), 0)
    const starts = reports.flatMap((r) => r.starts || [])
    const streams = reports.flatMap((r) => r.streams || [])
    const members = [...new Set(reports.map((r) => r.member))]
    assert(reports.length > 0 && members.length === 1 && /^telemediastream#[0-9a-f]{12}$/.test(members[0]), 'reports arrived, signed, under one name with the object id: ' + members)
    assert(bytes >= f11.size * 2 + f12.size * 2, `usage bytes ${bytes}`)
    assert(starts.some((s) => s.token === TOKEN && s.ua), 'stream starts with user-agent')
    assert(streams.some((s) => s.msg === 12 && s.chat === world.channelId && s.name.includes('Pattiyal') && s.bytes > 0), 'live stream entries')
    ok(`the app received ${reports.length} signed reports: ${(bytes / 1048576).toFixed(1)} MB for the token, starts and live streams`)
  }

  // 9. a user of the app hosted on this Worker, streaming with their own bot:
  //    the app signs that user's links and sync with the user's secret; the Worker serves them
  //    from a separate Durable Object logged in as the user's bot, reporting under its own name
  {
    const TOKEN_U = 'UsrAliceTok0123456789abcdefghijkl'
    const ulink = (msg) => py('link', SECRET_ALICE, W, TOKEN_U, py('encode', JSON.stringify({ chat_id: world.channelId, msg_id: msg })), 'video.mp4')
    const t = Date.now()
    const r = await fetch(ulink(12))
    const body = await bytesOf(r)
    assert(r.status === 200 && B.equal(body, all12), 'user stream exact, got ' + r.status)
    assert(world.log.includes('dc2: bot 7002 logged in'), "the user's own bot logged in")
    const us = await (await fetch(W + '/status/alice')).json()
    assert(us.ok && us.user === 'alice' && us.bot === 'logged in (DC 2)', 'user status ' + JSON.stringify(us))
    const ms = await (await fetch(W + '/status')).json()
    assert(ms.ok && !ms.user && ms.bot === 'logged in (DC 4)' && ms.users === 1 && ms.ignoredUserSecrets === 1, 'main status ' + JSON.stringify(ms))
    assert((await fetch(W + '/status/nobody')).status === 404, 'unknown user -> 404')
    const before = (await (await fetch(APP + '/_reports')).json()).config_calls_by
    const [ts, sig] = py('sync', SECRET_ALICE).split(' ')
    const s = await fetch(W + '/api/sync', { method: 'POST', body: '{}', headers: { 'x-cf-time': ts, 'x-cf-sig': sig } })
    assert(s.status === 200, 'user sync accepted')
    const after = (await (await fetch(APP + '/_reports')).json()).config_calls_by
    assert(after.alice === before.alice + 1 && after.main === before.main, 'sync reloads only that user ' + JSON.stringify([before, after]))
    await sleep(2500)
    const { reports } = await (await fetch(APP + '/_reports')).json()
    const users = reports.filter((x) => x._by === 'alice')
    assert(users.length > 0 && users.every((x) => /^telemediastream:alice#[0-9a-f]{12}$/.test(x.member)) && new Set(users.map((x) => x.member)).size === 1, "user's reports signed with the user's secret, own name")
    assert(users.reduce((n, x) => n + ((x.usage || {})[TOKEN_U] || 0), 0) >= f12.size, "user's usage counted")
    const mains = new Set(reports.filter((x) => x._by === 'main').map((x) => x.member))
    assert(mains.size === 1 && /^telemediastream#[0-9a-f]{12}$/.test([...mains][0]) && !mains.has(users[0].member), 'main reports keep their own name')
    const stranger = py('link', 'not-a-user-secret', W, TOKEN_U, py('encode', JSON.stringify({ chat_id: world.channelId, msg_id: 12 })), 'v.mp4')
    assert((await fetch(stranger)).status === 403, 'unknown secret -> 403')
    ok(`a user's own bot streams through their own Durable Object (${Date.now() - t} ms); status, sync and reports stay apart`)
  }

  // 10. app down: streaming continues with the last known settings
  {
    children[0].kill()
    await sleep(500)
    const [ts, sig] = py('sync', SECRET).split(' ')
    await fetch(W + '/api/sync', { method: 'POST', body: '{}', headers: { 'x-cf-time': ts, 'x-cf-sig': sig } })
    const r = await fetch(fileLink(11), { headers: { Range: 'bytes=100-200000' } })
    assert(r.status === 206 && B.equal(await bytesOf(r), all11.subarray(100, 200001)), 'stream while app is down')
    ok('app offline: playback keeps working with cached bot settings')
  }

  console.log(`\ne2e: ${passed} scenarios passed in workerd`)
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  // wrangler runs workerd as its own child: stop the whole process group, or workerd keeps the port
  for (const c of children) try { process.kill(-c.pid) } catch { try { c.kill() } catch {} }
  world.stop()
  setTimeout(() => process.exit(process.exitCode || 0), 300)
}
