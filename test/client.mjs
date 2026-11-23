// Integration test: the Worker's Telegram client against the fake multi-DC Telegram server.
import { connect, MemoryStorage, initTestCrypto, assert } from './shims.mjs'
import { World, fileBytes } from './fake-telegram.mjs'
import { TelegramClient, HttpError, PART } from '../src/telegram.js'
import * as B from '../src/mtproto/bytes.js'

initTestCrypto()
const world = new World()
const ports = await world.start()
const dcAddrs = Object.fromEntries(Object.entries(ports).map(([dc, p]) => [dc, ['127.0.0.1', p]]))
const rsaKeys = [{ fp: world.rsa.fp, n: world.rsa.n, e: world.rsa.e }]
let appCfg = { apiId: world.apiId, apiHash: world.apiHash, bots: ['111:AAA-test-token'] }
const storage = new MemoryStorage()
const logs = []
const mk = () => new TelegramClient({ connect, storage, dcAddrs, rsaKeys, getAppConfig: async () => appCfg, log: (m) => logs.push(m) })

let passed = 0
const ok = (n) => { passed++; console.log('  ok  ' + n) }
const chat = world.channelId

async function download(tg, msg, info, parallel = 4) {
  const f = world.files.get(msg)
  const out = new Uint8Array(f.size)
  const offsets = []
  for (let o = 0; o < f.size; o += PART) offsets.push(o)
  let i = 0
  const worker = async () => {
    while (i < offsets.length) {
      const o = offsets[i++]
      const data = await tg.part(info, o, () => tg.fileInfo(chat, msg))
      out.set(data, o)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  return out
}

try {
  // 1. fresh start: DH on DC2, bot migrates to DC4, file lives on DC5
  let tg = mk()
  const t0 = Date.now()
  const info = await tg.fileInfo(chat, 11)
  assert(info.dc === 5 && info.size === world.files.get(11).size, 'file info dc/size')
  assert(info.name === 'Arinthum Ariyamalum (2005) 1080p.mkv' && info.mime === 'video/x-matroska', 'file name/mime')
  assert(tg.home && tg.home.dc === 4, 'bot home DC should be 4 after USER_MIGRATE_4')
  ok(`login with USER_MIGRATE_4 + bad_server_salt + gzip reply, file info in ${Date.now() - t0} ms`)

  // 2. download across DCs with an expiring file reference mid-way
  const t1 = Date.now()
  const got = await download(tg, 11, info, 4)
  const want = fileBytes(11, 0, world.files.get(11).size)
  assert(B.equal(got, want), 'downloaded bytes match')
  assert(world.log.includes('dc5: authorization imported'), 'authorization exported to DC5')
  assert(world.fileRefVersion === 2, 'file reference rotated during download')
  ok(`downloaded ${(want.length / 1048576).toFixed(2)} MB from DC5 (export/import auth, FILE_REFERENCE_EXPIRED) in ${Date.now() - t1} ms`)

  // 3. two files in parallel on shared connections
  const info12 = await tg.fileInfo(chat, 12)
  const info13 = await tg.fileInfo(chat, 13)
  const [a, b] = await Promise.all([download(tg, 12, info12, 4), download(tg, 13, info13, 1)])
  assert(B.equal(a, fileBytes(12, 0, world.files.get(12).size)) && B.equal(b, fileBytes(13, 0, 777)), 'parallel downloads')
  ok('two files downloaded concurrently over the DC5 connection pool')

  // 4. Telegram forgets the DC5 key -> transport -404 -> new key + re-import
  world.forgetKeysForDc(5)
  const p = await tg.part(info, 2 * PART, () => tg.fileInfo(chat, 11))
  assert(B.equal(p, fileBytes(11, 2 * PART, 3 * PART)), 'part after -404')
  ok('recovered from Telegram forgetting the auth key (-404)')

  // 5. restart: a new client instance reuses stored keys, no new login
  tg.closeAll()
  const keysBefore = world.log.filter((l) => l.includes('new auth key')).length
  const loginsBefore = world.log.filter((l) => l.includes('logged in')).length
  tg = mk()
  const info2 = await tg.fileInfo(chat, 11)
  const p2 = await tg.part(info2, 0, () => tg.fileInfo(chat, 11))
  assert(B.equal(p2, fileBytes(11, 0, PART)), 'part after restart')
  assert(world.log.filter((l) => l.includes('new auth key')).length === keysBefore, 'no new auth keys after restart')
  assert(world.log.filter((l) => l.includes('logged in')).length === loginsBefore, 'no new bot login after restart')
  ok('restart reuses stored auth keys and login')

  // 6. bot token changed in the app -> old sessions dropped, new bot logs in
  appCfg = { ...appCfg, bots: ['222:BBB-other'] }
  const info3 = await tg.fileInfo(chat, 12)
  assert(tg.home.dc === 2 && info3.size === world.files.get(12).size, 'new bot on DC2')
  const p3 = await tg.part(info3, PART, () => tg.fileInfo(chat, 12))
  assert(B.equal(p3, fileBytes(12, PART, 2 * PART)), 'part with new bot')
  ok('bot token change in the app triggers a clean re-login')

  // 7. errors that reach the viewer
  try { await tg.fileInfo(chat, 99); assert(false, 'should throw') } catch (e) {
    assert(e instanceof HttpError && e.status === 404, 'deleted message -> 404')
  }
  try { await tg.fileInfo(555, 11); assert(false, 'should throw') } catch (e) {
    assert(e instanceof HttpError && e.status === 502 && /admin/.test(e.message), 'unknown channel -> 502 with hint')
  }
  appCfg = { ...appCfg, bots: ['999:bad'] }
  try { await tg.fileInfo(chat, 11); assert(false, 'should throw') } catch (e) {
    assert(e instanceof HttpError && /ACCESS_TOKEN_INVALID/.test(e.message), 'bad token -> clear error')
  }
  ok('deleted file, foreign channel and bad bot token give clear errors')
  tg.closeAll()

  // 8. Cloudflare holds a connection back (or Telegram never answers it): an extra connection
  //    to a DC that never opens must not stall downloads on the connection that already works
  appCfg = { ...appCfg, bots: ['111:AAA-test-token'] }
  const hang = new Set()
  const blackHole = () => ({
    opened: new Promise(() => {}),
    writable: new WritableStream({ write: () => new Promise(() => {}) }),
    readable: new ReadableStream(),
    close() {},
  })
  const wrapped = (addr) => (hang.has(addr.port) ? blackHole() : connect(addr))
  const tg8 = new TelegramClient({
    connect: wrapped, storage: new MemoryStorage(), dcAddrs, rsaKeys,
    getAppConfig: async () => appCfg, log: (m) => logs.push(m), connectTimeoutMs: 400,
  })
  const info8 = await tg8.fileInfo(chat, 11)
  await tg8.part(info8, 0, () => tg8.fileInfo(chat, 11)) // first connection to the file's DC is up
  hang.add(ports[info8.dc]) // every further connection to that DC hangs
  const t8 = Date.now()
  const got8 = await download(tg8, 11, info8, 4)
  assert(B.equal(got8, fileBytes(11, 0, world.files.get(11).size)), 'download over the one working connection')
  ok(`a second connection that never opens does not stall the download (${Date.now() - t8} ms)`)

  // 9. a DC that cannot be reached at all fails with a clear error instead of hanging
  hang.add(ports[3])
  const t9 = Date.now()
  let err9 = null
  try { await tg8._session(3) } catch (e) { err9 = e }
  assert(err9 && /no connection to Telegram/.test(err9.message), 'clear connect-timeout error, got: ' + (err9 && err9.message))
  assert(Date.now() - t9 < 3000, 'gave up quickly')
  ok(`an unreachable DC fails in ${Date.now() - t9} ms: "${err9.message}"`)
  tg8.closeAll()
  console.log(`\nclient: ${passed} scenarios passed`)
} finally {
  world.stop()
  setTimeout(() => process.exit(process.exitCode || 0), 100)
}
