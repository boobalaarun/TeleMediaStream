// Link and request signing, exactly as the app does it.
import { toHex, bigToBytes } from './mtproto/bytes.js'

const enc = new TextEncoder()
const keys = new Map() // one imported key per secret (you + each user)

async function hmacKey(secret) {
  let key = keys.get(secret)
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    if (keys.size >= 64) keys.delete(keys.keys().next().value)
    keys.set(secret, key)
  }
  return key
}

export async function hmacHex(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message))
  return toHex(new Uint8Array(sig))
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// Link: {worker}/dl/{token}/{id}/{name}?e={exp}&s={HMAC(secret, "/dl/{token}/{id}:{exp}")[:32]}
export async function verifyLink(secret, token, id, e, s) {
  if (!e || !s || !/^\d{1,12}$/.test(e)) return false
  if (Number(e) < Math.floor(Date.now() / 1000)) return false
  const expect = (await hmacHex(secret, `/dl/${token}/${id}:${e}`)).slice(0, 32)
  return sameString(expect, s.toLowerCase())
}

// Worker <-> app requests: x-cf-time / x-cf-sig = HMAC(secret, "{ts}\n{METHOD} {path}\n{body}")
export async function signRequest(secret, method, path, body) {
  const ts = String(Math.floor(Date.now() / 1000))
  return { 'x-cf-time': ts, 'x-cf-sig': await hmacHex(secret, `${ts}\n${method} ${path}\n${body}`) }
}

export async function verifyRequest(secret, method, path, body, ts, sig) {
  if (!secret || !ts || !sig || !/^\d+$/.test(ts)) return false
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  return sameString(await hmacHex(secret, `${ts}\n${method} ${path}\n${body}`), sig)
}

// Stream ids are base62(zlib(json)) — Backend/helper/encrypt.py
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export async function decodeStreamId(id) {
  if (!id || id.length > 2000) throw new Error('bad id')
  let n = 0n
  for (const ch of id) {
    const v = B62.indexOf(ch)
    if (v < 0) throw new Error('bad id')
    n = n * 62n + BigInt(v)
  }
  const bytes = n === 0n ? new Uint8Array([0]) : bigToBytes(n)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  const text = await new Response(stream).text()
  return JSON.parse(text)
}
