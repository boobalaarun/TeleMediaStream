// Node stand-ins for cloudflare:sockets connect() and Durable Object storage.
import net from 'node:net'
import { Readable, Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { initCrypto } from '../src/mtproto/crypto.js'

export function connect({ hostname, port }) {
  const sock = net.connect({ host: hostname, port })
  sock.setNoDelay(true)
  const opened = new Promise((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  sock.on('error', () => {})
  return {
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    opened,
    close() { sock.destroy() },
  }
}

export class MemoryStorage {
  constructor() { this.m = new Map() }
  async get(k) {
    if (Array.isArray(k)) {
      const out = new Map()
      for (const x of k) if (this.m.has(x)) out.set(x, structuredClone(this.m.get(x)))
      return out
    }
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined
  }
  async put(k, v) { this.m.set(k, structuredClone(v)) }
  async delete(k) {
    if (Array.isArray(k)) { let n = 0; for (const x of k) if (this.m.delete(x)) n++; return n }
    return this.m.delete(k)
  }
  async list({ prefix = '' } = {}) {
    const out = new Map()
    for (const [k, v] of this.m) if (k.startsWith(prefix)) out.set(k, structuredClone(v))
    return out
  }
}

export function initTestCrypto() {
  const root = new URL('../src/vendor/', import.meta.url)
  initCrypto([
    new WebAssembly.Module(readFileSync(new URL('mtcute-simd.wasm', root))),
    new WebAssembly.Module(readFileSync(new URL('mtcute.wasm', root))),
  ])
}

export function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}
