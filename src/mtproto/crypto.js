// Crypto primitives. AES-256-IGE, SHA-1/256 for small inputs and gunzip run in the mtcute
// WebAssembly module (MIT), which a Worker must import as a precompiled module. Large SHA-256
// (whole 1 MB file parts) goes through native WebCrypto, which is ~4x faster than wasm.

let wasm = null
let mem = null
let keyPtr = 0, ivPtr = 0, outPtr = 0, decompressor = 0

export function initCrypto(modules) {
  if (wasm) return
  let lastErr
  for (const mod of modules) {
    try {
      const inst = new WebAssembly.Instance(mod, {})
      wasm = inst.exports
      break
    } catch (e) { lastErr = e }
  }
  if (!wasm) throw new Error('Could not start the crypto module: ' + lastErr)
  keyPtr = wasm.__get_shared_key_buffer()
  ivPtr = wasm.__get_shared_iv_buffer()
  outPtr = wasm.__get_shared_out()
  decompressor = wasm.libdeflate_alloc_decompressor()
}

function u8() {
  if (mem === null || mem.buffer !== wasm.memory.buffer || mem.byteLength === 0) mem = new Uint8Array(wasm.memory.buffer)
  return mem
}

// AES-256-IGE. key: 32 bytes, iv: 32 bytes. Returns a fresh Uint8Array.
export function igeEncrypt(data, key, iv) {
  const p = wasm.__malloc(data.length * 2)
  let m = u8()
  m.set(data, p); m.set(key, keyPtr); m.set(iv, ivPtr)
  wasm.ige256_encrypt(p, data.length, p + data.length)
  m = u8()
  const out = m.slice(p + data.length, p + data.length * 2)
  wasm.__free(p)
  return out
}

// AES-256-IGE decrypt. If `prefix` (Uint8Array) is given, the result is
// prefix || plaintext in one buffer (saves a copy before hashing).
export function igeDecrypt(data, key, iv, prefix) {
  const p = wasm.__malloc(data.length * 2)
  let m = u8()
  m.set(data, p); m.set(key, keyPtr); m.set(iv, ivPtr)
  wasm.ige256_decrypt(p, data.length, p + data.length)
  m = u8()
  let out
  if (prefix) {
    out = new Uint8Array(prefix.length + data.length)
    out.set(prefix, 0)
    out.set(m.subarray(p + data.length, p + data.length * 2), prefix.length)
  } else {
    out = m.slice(p + data.length, p + data.length * 2)
  }
  wasm.__free(p)
  return out
}

export function sha1(data) {
  const p = wasm.__malloc(data.length || 1)
  u8().set(data, p)
  wasm.sha1(p, data.length)
  wasm.__free(p)
  return u8().slice(outPtr, outPtr + 20)
}

export function sha256(data) {
  const p = wasm.__malloc(data.length || 1)
  u8().set(data, p)
  wasm.sha256(p, data.length)
  wasm.__free(p)
  return u8().slice(outPtr, outPtr + 32)
}

export async function sha256Async(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export function gunzip(data) {
  const ip = wasm.__malloc(data.length)
  u8().set(data, ip)
  const size = wasm.libdeflate_gzip_get_output_size(ip, data.length)
  const op = wasm.__malloc(size || 1)
  const ret = wasm.libdeflate_gzip_decompress(decompressor, ip, data.length, op, size)
  wasm.__free(ip)
  if (ret !== 0) { wasm.__free(op); throw new Error('gunzip failed: ' + ret) }
  const out = u8().slice(op, op + size)
  wasm.__free(op)
  return out
}
