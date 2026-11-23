// Load probe (not part of `npm test`): N viewers hold streams of a large file open at the same
// time in workerd (wrangler dev --local), and we read the workerd process memory. One Durable
// Object serves every viewer and Cloudflare gives it 128 MB, so memory per viewer sets the limit.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { initTestCrypto } from './shims.mjs'
import { World } from './fake-telegram.mjs'

initTestCrypto()
const here = new URL('.', import.meta.url).pathname
const root = new URL('..', import.meta.url).pathname
const py = (...a) => execFileSync('python3', [here + 'app_ref.py', ...a], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STEPS = (process.argv[2] || '1,5,10,20').split(',').map(Number)

const world = new World({ expireRefAfter: 0 })
world.files.set(14, { id: 9004n, accessHash: 8888n, size: 1200 * 1048576, name: 'Big (2010) 1080p.mkv', mime: 'video/x-matroska', seed: 14 })
const ports = await world.start()
const SECRET = 'load' + randomBytes(16).toString('hex')
const TOKEN = 'CurrFtBwIfmWmqbNcnpyAzCOClS7F2gj'
const APP_PORT = 18199, WORKER_PORT = 18887
const W = `http://127.0.0.1:${WORKER_PORT}`
const APP = `http://127.0.0.1:${APP_PORT}`
const children = []

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
}
const dir = here + '.load/'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(dir + 'wrangler.toml', `name = "telemediastream-load"
main = "../../src/index.js"
compatibility_date = "2026-10-01"

[define]
__TEST_OVERRIDES__ = ${JSON.stringify(JSON.stringify(overrides))}

[vars]
APP_URL = "${APP}"
SHARED_SECRET = "${SECRET}"

[[durable_objects.bindings]]
name = "CORE"
class_name = "TeleCore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TeleCore"]
`)

const link = (msg) => py('link', SECRET, W, TOKEN, py('encode', JSON.stringify({ chat_id: world.channelId, msg_id: msg })), 'video.mkv')
const workerdMB = () => Number(execFileSync('sh', ['-c', "ps -C workerd -o rss= | awk '{s+=$1} END {print s+0}'"], { encoding: 'utf8' }).trim()) / 1024

// a viewer: starts at `offset`, reads 3 MB, then stops reading (like a player with a full buffer)
async function viewer(url, offset) {
  const r = await fetch(url, { headers: { Range: `bytes=${offset}-` } })
  if (r.status !== 206) throw new Error('viewer got ' + r.status)
  const reader = r.body.getReader()
  let got = 0
  while (got < 3 * 1048576) {
    const { value, done } = await reader.read()
    if (done) break
    got += value.length
  }
  return reader
}

try {
  const app = spawn('python3', [here + 'fake_app.py', String(APP_PORT), SECRET, String(world.apiId), world.apiHash, '111:AAA-test-token'], { stdio: 'ignore' })
  children.push(app)
  await waitFor(APP + '/_reports', 15000)
  const wr = spawn('npx', ['wrangler', 'dev', '--config', dir + 'wrangler.toml', '--port', String(WORKER_PORT), '--ip', '127.0.0.1',
    '--local', '--persist-to', dir + 'state', '--log-level', 'error', '--inspector-port', '0'],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: 'ignore', detached: true })
  children.push(wr)
  await waitFor(W + '/', 90000)

  const url = link(14)
  // warm-up: login, keys, code loaded
  const warm = await fetch(link(11))
  await warm.arrayBuffer()
  await sleep(4000)
  const base = workerdMB()
  console.log(`baseline after one finished play: workerd ${base.toFixed(0)} MB`)

  const readers = []
  for (const n of STEPS) {
    while (readers.length < n) readers.push(await viewer(url, readers.length * 37 * 1048576))
    await sleep(8000)
    const st = await (await fetch(W + '/status')).json()
    const mb = workerdMB()
    console.log(`${String(n).padStart(3)} viewers holding streams: activeStreams=${st.activeStreams}, ` +
      `connections=${JSON.stringify(st.connections)}, workerd ${mb.toFixed(0)} MB ` +
      `(+${(mb - base).toFixed(0)} MB, ${((mb - base) / n).toFixed(1)} MB per viewer)`)
  }
  for (const r of readers) r.cancel().catch(() => {})
  await sleep(3000)
  const st = await (await fetch(W + '/status')).json()
  console.log(`after all viewers left: activeStreams=${st.activeStreams}, workerd ${workerdMB().toFixed(0)} MB`)
} finally {
  for (const c of children) { try { process.kill(-c.pid) } catch { try { c.kill('SIGTERM') } catch {} } }
  try { execFileSync('pkill', ['-f', 'telemediastream-load']) } catch {}
  world.stop()
  setTimeout(() => process.exit(0), 500)
}
