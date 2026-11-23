// Small byte / bigint helpers shared by the MTProto code.

export function concat(...parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function randomBytes(n) {
  const out = new Uint8Array(n)
  // getRandomValues is limited to 65536 bytes per call
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)))
  return out
}

export function xor(a, b) {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

export function equal(a, b) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export function toHex(b) {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function fromHex(h) {
  const out = new Uint8Array(h.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

// Big-endian bytes <-> unsigned BigInt
export function bytesToBig(b) {
  return b.length ? BigInt('0x' + toHex(b)) : 0n
}

export function bigToBytes(n, len) {
  let h = n.toString(16)
  if (h.length & 1) h = '0' + h
  let b = fromHex(h)
  if (len !== undefined) {
    if (b.length > len) throw new Error('bigToBytes: value too large')
    if (b.length < len) b = concat(new Uint8Array(len - b.length), b)
  }
  return b
}

export function reversed(b) {
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]
  return out
}

export function modPow(base, exp, mod) {
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

// Little-endian 64-bit signed BigInt from bytes (used for auth_key_id, salts)
export function readLongLE(b, o = 0) {
  return new DataView(b.buffer, b.byteOffset + o, 8).getBigInt64(0, true)
}

export function writeLongLE(n) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt.asIntN(64, n), true)
  return out
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
