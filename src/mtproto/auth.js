// Authorization key exchange (https://core.telegram.org/mtproto/auth_key), using the
// RSA_PAD scheme for req_DH_params and Telegram's fixed 2048-bit DH prime.
import * as B from './bytes.js'
import { sha1, sha256, igeEncrypt, igeDecrypt } from './crypto.js'
import { TlReader, reqPqMulti, pqInnerDataDc, reqDhParams, clientDhInnerData, setClientDhParams } from './tl.js'

export const DH_PRIME = BigInt('0x' +
  'C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F' +
  '48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C37' +
  '20FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F64' +
  '2477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4' +
  'A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754' +
  'FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4' +
  'E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F' +
  '0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B')

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a }
const abs = (a) => (a < 0n ? -a : a)

function randBelow(n) {
  return (B.bytesToBig(B.randomBytes(16)) % (n - 2n)) + 1n
}

// Pollard-Brent factorization of pq (a ~63-bit semiprime)
export function factorize(pq) {
  if (pq % 2n === 0n) return [2n, pq / 2n]
  for (let attempt = 0; attempt < 10; attempt++) {
    let y = randBelow(pq), c = randBelow(pq)
    const m = 128n
    let g = 1n, r = 1n, q = 1n, x = 0n, ys = 0n
    while (g === 1n) {
      x = y
      for (let i = 0n; i < r; i++) y = (y * y + c) % pq
      let k = 0n
      while (k < r && g === 1n) {
        ys = y
        const lim = m < r - k ? m : r - k
        for (let i = 0n; i < lim; i++) {
          y = (y * y + c) % pq
          q = (q * abs(x - y)) % pq
        }
        g = gcd(q, pq)
        k += m
      }
      r *= 2n
    }
    if (g === pq) {
      do {
        ys = (ys * ys + c) % pq
        g = gcd(abs(x - ys), pq)
      } while (g === 1n)
    }
    if (g !== pq && g !== 1n) {
      const other = pq / g
      return g < other ? [g, other] : [other, g]
    }
  }
  throw new Error('could not factorize pq')
}

export function rsaPad(data, key) {
  if (data.length > 144) throw new Error('RSA_PAD: data too long')
  for (;;) {
    const withPadding = B.concat(data, B.randomBytes(192 - data.length))
    const tempKey = B.randomBytes(32)
    const withHash = B.concat(B.reversed(withPadding), sha256(B.concat(tempKey, withPadding)))
    const aesEncrypted = igeEncrypt(withHash, tempKey, new Uint8Array(32))
    const keyAesEncrypted = B.concat(B.xor(tempKey, sha256(aesEncrypted)), aesEncrypted)
    const m = B.bytesToBig(keyAesEncrypted)
    if (m >= key.n) continue
    return B.bigToBytes(B.modPow(m, key.e, key.n), 256)
  }
}

function tmpKeyIv(newNonce, serverNonce) {
  const a = sha1(B.concat(newNonce, serverNonce))
  const b = sha1(B.concat(serverNonce, newNonce))
  const c = sha1(B.concat(newNonce, newNonce))
  return {
    key: B.concat(a, b.subarray(0, 12)),
    iv: B.concat(b.subarray(12, 20), c, newNonce.subarray(0, 4)),
  }
}

function checkG(g, p) {
  const ok =
    (g === 2 && p % 8n === 7n) ||
    (g === 3 && p % 3n === 2n) ||
    g === 4 ||
    (g === 5 && [1n, 4n].includes(p % 5n)) ||
    (g === 6 && [19n, 23n].includes(p % 24n)) ||
    (g === 7 && [3n, 5n, 6n].includes(p % 7n))
  if (!ok) throw new Error('DH: bad generator')
}

function checkGx(gx, p) {
  const low = 1n << (2048n - 64n)
  if (!(gx > 1n && gx < p - 1n && gx > low && gx < p - low)) throw new Error('DH: unsafe g_a/g_b')
}

const parse = (body) => new TlReader(body).object()

// Older scheme (what pyrofork uses today): RSA(SHA1(data) + data + padding to 255 bytes)
export function rsaLegacy(data, key) {
  let withHash = B.concat(sha1(data), data)
  if (withHash.length > 255) throw new Error('RSA: data too long')
  withHash = B.concat(withHash, B.randomBytes(255 - withHash.length))
  return B.bigToBytes(B.modPow(B.bytesToBig(withHash), key.e, key.n), 256)
}

// p_q_inner_data#83c95aec (no DC field), paired with the legacy RSA scheme
function pqInnerDataLegacy(pq, p, q, nonce, serverNonce, newNonce) {
  return B.concat(
    new Uint8Array([0xec, 0x5a, 0xc9, 0x83]),
    tlBytes(pq), tlBytes(p), tlBytes(q), nonce, serverNonce, newNonce,
  )
}

function tlBytes(b) {
  const pad = (4 - ((b.length + 1) % 4)) % 4
  return B.concat(new Uint8Array([b.length]), b, new Uint8Array(pad))
}

/**
 * Create a permanent auth key for a DC.
 * plainCall(body) -> Promise<Uint8Array> sends an unencrypted message and resolves with the reply body.
 * keys: [{ fp: BigInt(unsigned), n: BigInt, e: BigInt }]
 * flip=false: RSA_PAD for current keys, legacy SHA1/RSA for old keys (mtcute's rule);
 * flip=true: the other scheme (retry path if Telegram refused the first one)
 */
export async function createAuthKey(plainCall, dcId, keys, dhPrime = DH_PRIME, flip = false) {
  const nonce = B.randomBytes(16)
  const resPq = parse(await plainCall(reqPqMulti(nonce)))
  if (resPq._ !== 'mt_resPQ' || !B.equal(resPq.nonce, nonce)) throw new Error('DH: bad resPQ')
  const serverNonce = new Uint8Array(resPq.serverNonce)

  let key = null
  for (const fp of resPq.serverPublicKeyFingerprints) {
    const u = BigInt.asUintN(64, fp)
    key = keys.find((k) => k.fp === u)
    if (key) break
  }
  if (!key) throw new Error('DH: no known server RSA key')

  const pqBytes = new Uint8Array(resPq.pq)
  const [p, q] = factorize(B.bytesToBig(pqBytes))
  const pBytes = B.bigToBytes(p), qBytes = B.bigToBytes(q)
  const newNonce = B.randomBytes(32)

  const legacy = flip ? !key.old : !!key.old
  const encrypted = legacy
    ? rsaLegacy(pqInnerDataLegacy(pqBytes, pBytes, qBytes, nonce, serverNonce, newNonce), key)
    : rsaPad(pqInnerDataDc(pqBytes, pBytes, qBytes, nonce, serverNonce, newNonce, dcId), key)
  const dh = parse(await plainCall(reqDhParams(nonce, serverNonce, pBytes, qBytes, BigInt.asIntN(64, key.fp), encrypted)))
  if (dh._ !== 'mt_server_DH_params_ok') throw new Error('DH: server refused params (' + dh._ + ')')
  if (!B.equal(dh.nonce, nonce) || !B.equal(dh.serverNonce, serverNonce)) throw new Error('DH: nonce mismatch')

  const tmp = tmpKeyIv(newNonce, serverNonce)
  const answer = igeDecrypt(dh.encryptedAnswer, tmp.key, tmp.iv)
  const r = new TlReader(answer, 20)
  const data = r.object()
  if (!B.equal(sha1(answer.subarray(20, r.pos)), answer.subarray(0, 20))) throw new Error('DH: answer hash mismatch')
  if (data._ !== 'mt_server_DH_inner_data' || !B.equal(data.nonce, nonce) || !B.equal(data.serverNonce, serverNonce)) {
    throw new Error('DH: bad inner data')
  }
  const g = data.g
  const prime = B.bytesToBig(data.dhPrime)
  if (prime !== dhPrime) throw new Error('DH: unexpected prime')
  checkG(g, prime)
  const gA = B.bytesToBig(data.gA)
  checkGx(gA, prime)
  const timeOffset = data.serverTime - Math.floor(Date.now() / 1000)

  let retryId = 0n
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = B.bytesToBig(B.randomBytes(256))
    const gB = B.modPow(BigInt(g), b, prime)
    checkGx(gB, prime)
    const clientData = clientDhInnerData(nonce, serverNonce, retryId, B.bigToBytes(gB, 256))
    let withHash = B.concat(sha1(clientData), clientData)
    if (withHash.length % 16) withHash = B.concat(withHash, B.randomBytes(16 - (withHash.length % 16)))
    const res = parse(await plainCall(setClientDhParams(nonce, serverNonce, igeEncrypt(withHash, tmp.key, tmp.iv))))

    const authKey = B.bigToBytes(B.modPow(gA, b, prime), 256)
    const auxHash = sha1(authKey).subarray(0, 8)
    const expect = (n) => sha1(B.concat(newNonce, new Uint8Array([n]), auxHash)).subarray(4, 20)
    if (!B.equal(res.nonce, nonce) || !B.equal(res.serverNonce, serverNonce)) throw new Error('DH: nonce mismatch (gen)')
    if (res._ === 'mt_dh_gen_ok') {
      if (!B.equal(res.newNonceHash1, expect(1))) throw new Error('DH: new_nonce_hash1 mismatch')
      const salt = B.readLongLE(B.xor(newNonce.subarray(0, 8), serverNonce.subarray(0, 8)))
      return { authKey, salt, timeOffset }
    }
    if (res._ === 'mt_dh_gen_retry') {
      if (!B.equal(res.newNonceHash2, expect(2))) throw new Error('DH: new_nonce_hash2 mismatch')
      retryId = B.readLongLE(auxHash)
      continue
    }
    throw new Error('DH: key generation failed')
  }
  throw new Error('DH: too many retries')
}
