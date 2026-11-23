// Unit tests: crypto vs OpenSSL, TL bytes vs mtcute's generated writer, and link/id/range
// handling vs the app's own Python code (via app_ref.py).
import { execFileSync } from 'node:child_process'
import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto'
import zlib from 'node:zlib'
import Long from 'long'
import { TlBinaryWriter } from '@mtcute/tl-runtime'
import { __tlWriterMap } from '@mtcute/tl/binary/writer.js'
import { initTestCrypto, assert } from './shims.mjs'
import { igeEncrypt, igeDecrypt, sha1, sha256, gunzip } from '../src/mtproto/crypto.js'
import * as TL from '../src/mtproto/tl.js'
import * as B from '../src/mtproto/bytes.js'
import { factorize, rsaPad } from '../src/mtproto/auth.js'
import { verifyLink, signRequest, verifyRequest, decodeStreamId } from '../src/links.js'
import { parseRange } from '../src/http.js'
import { tenants, secretFor, objectName, memberName, secretKey, MAIN } from '../src/tenants.js'
import { addBytes, mergeHours, summarize, hourOf } from '../src/stats.js'
import { appUrl, locationHint } from '../src/settings.js'
import { makeRsaKey } from './fake-telegram.mjs'

initTestCrypto()
let passed = 0
const ok = (name) => { passed++; console.log('  ok  ' + name) }
const py = (...args) => execFileSync('python3', [new URL('./app_ref.py', import.meta.url).pathname, ...args], { encoding: 'utf8' }).trim()
const ser = (obj) => new Uint8Array(TlBinaryWriter.serializeObject(__tlWriterMap, obj))
const L = (b) => Long.fromString(BigInt.asIntN(64, BigInt(b)).toString())

// ---------- crypto ----------
function igeRef(plain, key, iv) {
  const out = Buffer.alloc(plain.length)
  let y = Buffer.from(iv.subarray(0, 16)), x = Buffer.from(iv.subarray(16, 32))
  for (let o = 0; o < plain.length; o += 16) {
    const p = plain.subarray(o, o + 16)
    const inb = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) inb[i] = p[i] ^ y[i]
    const c = createCipheriv('aes-256-ecb', key, null).setAutoPadding(false).update(inb)
    for (let i = 0; i < 16; i++) c[i] ^= x[i]
    c.copy(out, o); y = c; x = Buffer.from(p)
  }
  return new Uint8Array(out)
}
{
  for (const len of [16, 4096, 1048576 + 48]) {
    const key = randomBytes(32), iv = randomBytes(32), plain = randomBytes(len)
    const ref = igeRef(plain, key, iv)
    assert(B.equal(igeEncrypt(plain, key, iv), ref), 'ige encrypt ' + len)
    assert(B.equal(igeDecrypt(ref, key, iv), plain), 'ige decrypt ' + len)
    const prefix = randomBytes(32)
    assert(B.equal(igeDecrypt(ref, key, iv, prefix), B.concat(prefix, plain)), 'ige decrypt with prefix')
  }
  ok('AES-256-IGE matches OpenSSL (16 B, 4 KB, 1 MB)')
  const d = randomBytes(5000)
  assert(B.equal(sha1(d), createHash('sha1').update(d).digest()), 'sha1')
  assert(B.equal(sha256(d), createHash('sha256').update(d).digest()), 'sha256')
  assert(B.equal(gunzip(zlib.gzipSync(d)), d), 'gunzip')
  ok('SHA-1, SHA-256, gunzip match Node')
}

// ---------- TL writer vs mtcute ----------
{
  const nonce = randomBytes(16), sn = randomBytes(16), nn = randomBytes(32)
  const cases = [
    ['req_pq_multi', TL.reqPqMulti(nonce), { _: 'mt_req_pq_multi', nonce }],
    ['p_q_inner_data_dc', TL.pqInnerDataDc(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8), nonce, sn, nn, 4),
      { _: 'mt_p_q_inner_data_dc', pq: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), p: Uint8Array.of(1, 2, 3, 4), q: Uint8Array.of(5, 6, 7, 8), nonce, serverNonce: sn, newNonce: nn, dc: 4 }],
    ['req_DH_params', TL.reqDhParams(nonce, sn, Uint8Array.of(1, 2), Uint8Array.of(3, 4), -3414540481677951611n, new Uint8Array(256).fill(7)),
      { _: 'mt_req_DH_params', nonce, serverNonce: sn, p: Uint8Array.of(1, 2), q: Uint8Array.of(3, 4), publicKeyFingerprint: L(-3414540481677951611n), encryptedData: new Uint8Array(256).fill(7) }],
    ['client_DH_inner_data', TL.clientDhInnerData(nonce, sn, 99n, new Uint8Array(256).fill(9)),
      { _: 'mt_client_DH_inner_data', nonce, serverNonce: sn, retryId: L(99n), gB: new Uint8Array(256).fill(9) }],
    ['set_client_DH_params', TL.setClientDhParams(nonce, sn, new Uint8Array(336).fill(3)),
      { _: 'mt_set_client_DH_params', nonce, serverNonce: sn, encryptedData: new Uint8Array(336).fill(3) }],
    ['msgs_ack', TL.msgsAck([1n, 2n, -3n]), { _: 'mt_msgs_ack', msgIds: [L(1n), L(2n), L(-3n)] }],
    ['importBotAuthorization in initConnection in invokeWithLayer',
      TL.invokeWithLayer(TL.initConnection(12345, TL.importBotAuthorization(12345, 'hash', '1:tok'))),
      { _: 'invokeWithLayer', layer: 223, query: { _: 'initConnection', apiId: 12345, deviceModel: 'Cloudflare Worker', systemVersion: 'workerd', appVersion: 'telemedia-stream 1.0', systemLangCode: 'en', langPack: '', langCode: 'en',
        query: { _: 'auth.importBotAuthorization', flags: 0, apiId: 12345, apiHash: 'hash', botAuthToken: '1:tok' } } }],
    ['auth.exportAuthorization', TL.exportAuthorization(5), { _: 'auth.exportAuthorization', dcId: 5 }],
    ['auth.importAuthorization', TL.importAuthorization(-77n, new Uint8Array(300).fill(1)), { _: 'auth.importAuthorization', id: L(-77n), bytes: new Uint8Array(300).fill(1) }],
    ['channels.getChannels', TL.channelsGetChannels(4359270588, 0n), { _: 'channels.getChannels', id: [{ _: 'inputChannel', channelId: 4359270588, accessHash: L(0n) }] }],
    ['channels.getMessages', TL.channelsGetMessages(4359270588, -123n, [11, 12]),
      { _: 'channels.getMessages', channel: { _: 'inputChannel', channelId: 4359270588, accessHash: L(-123n) }, id: [{ _: 'inputMessageID', id: 11 }, { _: 'inputMessageID', id: 12 }] }],
    ['upload.getFile', TL.uploadGetFile({ id: 9001n, accessHash: -5n, fileReference: Uint8Array.of(1, 2, 3) }, 7 * 1048576, 1048576),
      { _: 'upload.getFile', location: { _: 'inputDocumentFileLocation', id: L(9001n), accessHash: L(-5n), fileReference: Uint8Array.of(1, 2, 3), thumbSize: '' }, offset: 7 * 1048576, limit: 1048576 }],
  ]
  for (const [name, mine, obj] of cases) assert(B.equal(mine, ser(obj)), 'TL bytes differ: ' + name)
  ok(`TL requests byte-identical to mtcute's writer (${cases.length} kinds)`)
}

// ---------- TL reader on mtcute-serialized replies ----------
{
  const doc = {
    _: 'messages.channelMessages', pts: 1, count: 1, topics: [], users: [],
    chats: [{ _: 'channel', id: 4359270588, accessHash: L(-9876543210123n), title: 'x', photo: { _: 'chatPhotoEmpty' }, date: 1, broadcast: true }],
    messages: [{
      _: 'message', id: 11, post: true, peerId: { _: 'peerChannel', channelId: 4359270588 }, date: 1, message: 'cap',
      media: { _: 'messageMediaDocument', video: true, document: {
        _: 'document', id: L(-1234567890123456789n), accessHash: L(987654321987654321n), fileReference: Uint8Array.of(9, 8, 7), date: 1,
        mimeType: 'video/x-matroska', size: 50 * 1024 ** 3, dcId: 5,
        attributes: [{ _: 'documentAttributeVideo', duration: 1.5, w: 1, h: 1 }, { _: 'documentAttributeFilename', fileName: 'Movie (2005).mkv' }],
      } },
    }],
  }
  const o = new TL.TlReader(ser(doc)).object()
  const d = o.messages[0].media.document
  assert(o.chats[0].id === 4359270588 && o.chats[0].accessHash === -9876543210123n, 'channel id/hash')
  assert(d.id === -1234567890123456789n && d.accessHash === 987654321987654321n, 'document id/hash as BigInt')
  assert(d.size === 50 * 1024 ** 3 && d.dcId === 5 && d.mimeType === 'video/x-matroska', 'document size/dc/mime')
  assert(d.attributes[1].fileName === 'Movie (2005).mkv', 'file name')
  ok('TL reader parses a 50 GB channel document with BigInt ids')
}

// ---------- auth helpers ----------
{
  const primes = [1229739323n, 1402015859n, 2147483647n, 1000000007n, 998244353n]
  for (let i = 0; i < 4; i++) {
    const [p, q] = factorize(primes[i] * primes[i + 1])
    assert(p * q === primes[i] * primes[i + 1] && p < q, 'factorize')
  }
  ok('pq factorization')
  const k = makeRsaKey()
  const data = randomBytes(144)
  const enc = rsaPad(data, k)
  const m = B.bigToBytes(B.modPow(B.bytesToBig(enc), k.d, k.n), 256)
  const aes = m.subarray(32)
  const tempKey = B.xor(m.subarray(0, 32), sha256(aes))
  const withHash = igeDecrypt(aes, tempKey, new Uint8Array(32))
  const withPad = B.reversed(withHash.subarray(0, 192))
  assert(B.equal(withPad.subarray(0, 144), data), 'RSA_PAD roundtrip data')
  assert(B.equal(sha256(B.concat(tempKey, withPad)), withHash.subarray(192)), 'RSA_PAD hash')
  ok('RSA_PAD encryption decrypts with the private key')
}

// ---------- links vs the app ----------
{
  const secret = 'f3' + randomBytes(31).toString('hex')
  const token = 'CurrFtBwIfmWmqbNcnpyAzCOClS7F2gj'
  const id = py('encode', JSON.stringify({ chat_id: 4359270588, msg_id: 123 }))
  const link = new URL(py('link', secret, 'https://telemediastream.example.workers.dev', token, id, 'video.mkv'))
  const [, , t, i] = link.pathname.split('/')
  const e = link.searchParams.get('e'), s = link.searchParams.get('s')
  assert(await verifyLink(secret, t, i, e, s), 'valid app link accepted')
  assert(!(await verifyLink(secret + 'x', t, i, e, s)), 'other secret rejected')
  assert(!(await verifyLink(secret, t, i + 'a', e, s)), 'tampered id rejected')
  assert(!(await verifyLink(secret, t, i, String(Number(e) + 1), s)), 'tampered expiry rejected')
  assert(!(await verifyLink(secret, t, i, '1000', s)), 'expired link rejected')
  ok('links signed by the app verify; tampered/expired/other-secret links fail')

  const body = JSON.stringify({ usage: { [token]: 1048576 }, starts: [], member: 'm', streams: [] })
  const h = await signRequest(secret, 'POST', '/api/cf/usage', body)
  assert(py('verify', secret, 'POST', '/api/cf/usage', body, h['x-cf-time'], h['x-cf-sig']) === 'True', 'usage signature')
  const g = await signRequest(secret, 'GET', '/api/cf/config', '')
  assert(py('verify', secret, 'GET', '/api/cf/config', '', g['x-cf-time'], g['x-cf-sig']) === 'True', 'config signature')
  assert(py('verify', secret + 'x', 'GET', '/api/cf/config', '', g['x-cf-time'], g['x-cf-sig']) === 'False', 'wrong secret')
  ok("Worker's signed requests pass the app's verify_worker_request")

  const [ts, sig] = py('sync', secret).split(' ')
  assert(await verifyRequest(secret, 'POST', '/api/sync', '{}', ts, sig), 'sync accepted')
  assert(!(await verifyRequest(secret, 'POST', '/api/sync', '{}', String(Number(ts) - 1000), sig)), 'old sync rejected')
  ok("the app's /api/sync call is accepted")

  for (const obj of [
    { chat_id: 4359270588, msg_id: 123 },
    { chat_id: '4381736755', msg_id: 7 },
    { parts: [{ chat_id: 1, msg_id: 2 }, { chat_id: 1, msg_id: 3 }], zip: true },
    { global: true, chat_id: -100123, msg_id: 5 },
  ]) {
    const got = await decodeStreamId(py('encode', JSON.stringify(obj)))
    assert(JSON.stringify(got) === JSON.stringify(obj), 'decode ' + JSON.stringify(obj))
  }
  ok('stream ids from encode_string decode identically (single, split+zip, global)')
}

// ---------- ranges vs the app ----------
{
  const size = 5 * 1048576 + 123457
  const headers = ['', 'bytes=0-', 'bytes=0-0', 'bytes=100-', 'bytes=-500', 'bytes=1048576-2097151', 'bytes=5000000-99999999999',
    `bytes=${size}-`, `bytes=${size - 1}-`, 'bytes=10-5', 'bytes=abc', 'bytes=1-2,5-6', 'bytes=-0', `bytes=-${size + 10}`]
  for (const h of headers) {
    const mine = parseRange(h, size)
    const theirs = h === '' ? `0 ${size - 1}` : py('range', h, String(size))
    const m = mine ? `${mine.start} ${mine.end}` : '416'
    assert(m === theirs, `range "${h}": worker ${m} vs app ${theirs}`)
  }
  ok(`Range parsing matches the app's parse_range_header (${headers.length} cases)`)
}

// ---------- msg ids ----------
{
  const { Session } = await import('../src/mtproto/session.js')
  const s = new Session({ connect: () => ({}), host: 'x', port: 1, dcId: 2 })
  let last = 0n
  for (let i = 0; i < 1000; i++) {
    const id = s._nextMsgId()
    assert(id > last && id % 4n === 0n, 'msg_id monotonic and divisible by 4')
    last = id
  }
  assert(Math.abs(Number(last >> 32n) - Date.now() / 1000) < 2, 'msg_id carries unix time')
  ok('msg_id is time-based, increasing, divisible by 4')
}

// ---------- who a link belongs to: you or one user (USER_SECRET_<NAME>) ----------
{
  const env = {
    SHARED_SECRET: 'main-secret',
    USER_SECRET_ALICE: 'alice-secret',
    USER_SECRET_Friend1: '  friend-secret \n', // the app trims what it stores for a user
    USER_SECRET_DUP: 'main-secret', // same as the main secret: the app would treat it as yours
    USER_SECRET_TWIN: 'alice-secret', // same as another user's
    USER_SECRET_EMPTY: '',
    ['USER_SECRET_' + 'X'.repeat(33)]: 'long-name-secret',
    'USER_SECRET_BAD-NAME': 'dash-secret',
    OTHER_VAR: 'not a user', CORE: {},
  }
  const { list, ignored } = tenants(env)
  assert(JSON.stringify(list.map((t) => t.name)) === '["main","alice","friend1"]', 'tenants: ' + JSON.stringify(list))
  assert(ignored === 4, 'duplicate, twin, too-long and bad names ignored, got ' + ignored)
  assert(secretFor(env, 'friend1') === 'friend-secret' && secretFor(env, 'nobody') === '', 'secretFor')
  assert(objectName(MAIN) === 'telemedia-core' && objectName('alice') === 'user:alice', 'main keeps its object')
  assert(memberName(MAIN, 'a1b2c3d4e5f60718293a') === 'telemediastream#a1b2c3d4e5f6' && memberName('alice', 'ffeeddccbbaa99887766') === 'telemediastream:alice#ffeeddccbbaa', 'member names carry the object id')
  assert(secretKey('friend1') === 'USER_SECRET_FRIEND1' && secretKey(MAIN) === 'SHARED_SECRET', 'secret keys')
  assert(tenants({}).list.length === 0 && tenants({ USER_SECRET_A: 'a' }).list[0].name === 'a', 'users without a main secret')

  // a link the app signs for one user verifies only with that user's secret
  const exp = String(Math.floor(Date.now() / 1000) + 3600)
  const userLink = new URL(py('link', 'alice-secret', 'https://w.example', 'TokAlice123', 'AbC123', 'x.mkv'))
  const [, , tok, fid] = userLink.pathname.split('/')
  const owner = []
  for (const t of list) if (await verifyLink(t.secret, tok, fid, userLink.searchParams.get('e'), userLink.searchParams.get('s'))) owner.push(t.name)
  assert(JSON.stringify(owner) === '["alice"]', 'user link belongs to alice only, got ' + JSON.stringify(owner))
  assert(!(await verifyLink('main-secret', 'TokAlice123', 'AbC123', exp, '0'.repeat(32))), 'garbage signature fails')
  ok('USER_SECRET_<NAME> users: parsing, duplicates ignored, links routed to the right user')
}

// ---------- deployer settings: APP_URL and LOCATION_HINT ----------
{
  const good = {
    'https://stream.example.com': 'https://stream.example.com',
    ' https://Stream.Example.com/ ': 'https://stream.example.com',
    'https://stream.example.com:8443//': 'https://stream.example.com:8443',
    'http://127.0.0.1:8000': 'http://127.0.0.1:8000', // local tests only
  }
  for (const [raw, want] of Object.entries(good)) assert(appUrl({ APP_URL: raw }) === want, `APP_URL ${raw} -> ${appUrl({ APP_URL: raw })}`)
  const bad = ['', 'stream.example.com', 'http://stream.example.com', 'https://stream.example.com/app',
    'https://stream.example.com/?x=1', 'https://user:pw@stream.example.com', 'ftp://stream.example.com', 'https://']
  for (const raw of bad) assert(appUrl({ APP_URL: raw }) === '', 'APP_URL refused: ' + raw)
  assert(appUrl({}) === '' && appUrl({ APP_URL: 5 }) === '', 'missing APP_URL')
  assert(locationHint({}) === 'apac' && locationHint({ LOCATION_HINT: ' WEUR ' }) === 'weur' && locationHint({ LOCATION_HINT: 'mars' }) === 'apac', 'location hint')
  ok('APP_URL accepts an https origin only (plain http just for local tests); LOCATION_HINT validated')
}

// ---------- dashboard: bytes per UTC hour ----------
{
  const H = 3600000
  const t0 = Date.UTC(2026, 10, 23, 22, 30) // 22:30 UTC
  const pending = {}
  addBytes(pending, 100, t0)
  addBytes(pending, 50, t0 + 10 * 60000) // same hour
  addBytes(pending, 7, t0 + 2 * H) // 00:30 UTC the next day
  assert(pending[hourOf(t0)] === 150 && pending[hourOf(t0) + 2] === 7, 'bytes land in their UTC hour')
  const saved = { [hourOf(t0) - 60]: 999, [hourOf(t0)]: 1 } // one hour too old to keep
  mergeHours(saved, pending, t0 + 2 * H)
  assert(!saved[hourOf(t0) - 60] && saved[hourOf(t0)] === 151, 'merge adds counts and drops hours past 48')
  const s = summarize(saved, t0 + 2 * H)
  assert(s.today === 7, 'today counts from 00:00 UTC only, got ' + s.today)
  assert(s.hours.length === 24 && s.hours[23] === 7 && s.hours[21] === 151 && s.hours[22] === 0, 'last 24 hours, current last')
  assert((s.firstHour + 23) % 24 === 0, 'firstHour lines up with the current hour')
  ok('dashboard counts bytes per UTC hour: today from 00:00 UTC, last 24 hours, 48 hours kept')
}

console.log(`\nunit: ${passed} groups passed`)
