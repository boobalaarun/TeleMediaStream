// Independent checks against pyrofork, a Python Telegram library used in production.
// Needs a Python with pyrofork installed: PYROFORK_PYTHON=/path/to/venv/bin/python
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect, MemoryStorage, initTestCrypto, assert } from './shims.mjs'
import { World } from './fake-telegram.mjs'
import { TelegramClient } from '../src/telegram.js'
import { Session, RpcError } from '../src/mtproto/session.js'
import { sha1 } from '../src/mtproto/crypto.js'
import * as B from '../src/mtproto/bytes.js'

initTestCrypto()
const PY = process.env.PYROFORK_PYTHON || 'python3' // a Python with pyrofork installed
const script = new URL('./crosscheck_pyrogram.py', import.meta.url).pathname
const pyro = (...a) => execFileSync(PY, [script, ...a], { encoding: 'utf8', timeout: 120000 }).trim()
let passed = 0
const ok = (n) => { passed++; console.log('  ok  ' + n) }

// 1. pyrofork's own key exchange succeeds against the fake server (validates the fake server)
{
  const world = new World()
  const ports = await world.start([2])
  try {
    // async: the fake server runs in this process and must keep answering
    const { execFile } = await import('node:child_process')
    const keyHex = await new Promise((res, rej) => execFile(PY,
      [script, 'auth', String(ports[2]), world.rsa.n.toString(16), world.rsa.e.toString(16), world.rsa.fp.toString(16)],
      { encoding: 'utf8', timeout: 120000 }, (err, out, errout) => (err ? rej(new Error(errout || err.message)) : res(out.trim()))))
    const key = B.fromHex(keyHex)
    const stored = world.authKeys.get(B.toHex(sha1(key).subarray(12, 20)))
    assert(stored && B.equal(stored.authKey, key), 'pyrofork and fake server derived the same auth key')
    assert(world.log.includes('dc2: legacy RSA'), 'pyrofork used the legacy RSA scheme')
    ok("pyrofork's real key exchange completes against the fake Telegram (same 2048-bit auth key)")
  } finally { world.stop() }
}

// 2. our client falls back to the legacy scheme if Telegram refuses RSA_PAD
{
  const world = new World({ rejectRsaPad: true })
  const ports = await world.start()
  try {
    const tg = new TelegramClient({
      connect, storage: new MemoryStorage(),
      dcAddrs: Object.fromEntries(Object.entries(ports).map(([d, p]) => [d, ['127.0.0.1', p]])),
      rsaKeys: [{ fp: world.rsa.fp, n: world.rsa.n, e: world.rsa.e }],
      getAppConfig: async () => ({ apiId: world.apiId, apiHash: world.apiHash, bots: ['111:AAA-test-token'] }),
    })
    const info = await tg.fileInfo(world.channelId, 11)
    assert(info.dc === 5, 'file info via legacy keys')
    assert(world.log.includes('dc2: refused RSA_PAD') && world.log.includes('dc2: legacy RSA'), 'fallback happened')
    tg.closeAll()
    ok('if Telegram ever refuses RSA_PAD, the client falls back to the legacy scheme and still logs in')

    // an "old" server key goes straight to the legacy scheme (mtcute's rule)
    world.log.length = 0
    const tg2 = new TelegramClient({
      connect, storage: new MemoryStorage(),
      dcAddrs: Object.fromEntries(Object.entries(ports).map(([d, p]) => [d, ['127.0.0.1', p]])),
      rsaKeys: [{ fp: world.rsa.fp, n: world.rsa.n, e: world.rsa.e, old: true }],
      getAppConfig: async () => ({ apiId: world.apiId, apiHash: world.apiHash, bots: ['111:AAA-test-token'] }),
    })
    await tg2.fileInfo(world.channelId, 12)
    assert(world.log[0] === 'dc2: legacy RSA' && !world.log.includes('dc2: refused RSA_PAD'), 'old key -> legacy first')
    tg2.closeAll()
    ok('old Telegram keys use the legacy scheme on the first try')
  } finally { world.stop() }
}

// 3. our encrypted client->server message decrypts with pyrofork's kdf/AES and passes the msg_key check
{
  const authKey = new Uint8Array(randomBytes(256))
  const s = new Session({ connect: () => ({}), host: 'x', port: 1, dcId: 2, authKey, salt: -1234567890123n })
  const body = new Uint8Array(randomBytes(44))
  const msgId = s._nextMsgId()
  const pkt = s._encrypt(msgId, 7, body)
  const d = JSON.parse(pyro('client-msg', B.toHex(authKey), B.toHex(pkt)))
  assert(BigInt(d.salt) === -1234567890123n && d.session === B.toHex(s.sessionId) && BigInt(d.msg_id) === msgId && d.seq_no === 7, 'header fields')
  assert(d.body === B.toHex(body), 'body')
  ok('client -> Telegram encryption verified with pyrofork kdf/AES-IGE and the SHA-256 msg_key rule')
}

// 4. a server->client message built with pyrofork's primitives decrypts in our session
{
  const authKey = new Uint8Array(randomBytes(256))
  const s = new Session({ connect: () => ({}), host: 'x', port: 1, dcId: 2, authKey, salt: 5n })
  const reqId = s._nextMsgId()
  const err = (code, text) => {
    const t = new TextEncoder().encode(text)
    const pad = (4 - ((t.length + 1) % 4)) % 4
    const out = new Uint8Array(4 + 4 + 1 + t.length + pad)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, 0x2144ca19, true); dv.setInt32(4, code, true); out[8] = t.length; out.set(t, 9)
    return out
  }
  const inner = err(400, 'CROSSCHECK_OK')
  const body = new Uint8Array(12 + inner.length)
  new DataView(body.buffer).setUint32(0, 0xf35c6d01, true)
  new DataView(body.buffer).setBigInt64(4, reqId, true)
  body.set(inner, 12)
  const serverMsgId = ((BigInt(Math.floor(Date.now() / 1000)) << 32n) | 1n).toString()
  const pkt = B.fromHex(pyro('server-msg', B.toHex(authKey), B.toHex(s.sessionId), '5', serverMsgId, B.toHex(body)))
  const result = new Promise((resolve, reject) => s.pending.set(reqId, { resolve, reject, timer: null }))
  await s._onPacket(pkt)
  try { await result; assert(false, 'expected rpc error') } catch (e) {
    assert(e instanceof RpcError && e.text === 'CROSSCHECK_OK' && e.code === 400, 'decrypted rpc_error')
  }
  ok('Telegram -> client message built with pyrofork (and accepted by its unpack) decrypts in our session')
}

console.log(`\ncrosscheck: ${passed} checks passed`)
setTimeout(() => process.exit(process.exitCode || 0), 100)
