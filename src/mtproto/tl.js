// TL (Type Language) serialization. Reading uses the generated layer-223 reader map from mtcute;
// writing is hand-coded for the handful of requests this Worker sends.
import readers from '../vendor/tl-reader.js'

export const LAYER = 223

const VECTOR = 0x1cb5c415
const BOOL_TRUE = 0x997275b5
const BOOL_FALSE = 0xbc799737
const TRUE = 0x3fedd339
const NULL = 0x56730bcc
let READERS = null
const decoder = new TextDecoder()
const encoder = new TextEncoder()

export class TlReader {
  constructor(buf, pos = 0) {
    this.u8 = buf
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.pos = pos
  }
  int() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v }
  uint() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v }
  int53() {
    const v = this.dv.getUint32(this.pos, true) + 4294967296 * this.dv.getInt32(this.pos + 4, true)
    this.pos += 8
    return v
  }
  long() { const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v }
  double() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v }
  float() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v }
  boolean() {
    const v = this.uint()
    if (v === BOOL_TRUE) return true
    if (v === BOOL_FALSE) return false
    throw new Error('TL: expected Bool, got 0x' + v.toString(16))
  }
  raw(n) {
    if (n === undefined || n < 0) n = this.u8.length - this.pos
    const v = this.u8.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
  int128() { return this.raw(16) }
  int256() { return this.raw(32) }
  bytes() {
    let len = this.u8[this.pos++]
    let pad
    if (len === 254) {
      len = this.u8[this.pos] | (this.u8[this.pos + 1] << 8) | (this.u8[this.pos + 2] << 16)
      this.pos += 3
      pad = len % 4
    } else {
      pad = (len + 1) % 4
    }
    const v = this.raw(len)
    if (pad) this.pos += 4 - pad
    return v
  }
  string() { return decoder.decode(this.bytes()) }
  object(id) {
    if (id === undefined) id = this.uint()
    if (id === VECTOR) return this.vector(this.object, true)
    if (id === BOOL_TRUE || id === TRUE) return true
    if (id === BOOL_FALSE) return false
    if (id === NULL) return null
    const fn = (READERS || (READERS = readers()))[id]
    if (!fn) throw new Error('TL: unknown constructor 0x' + id.toString(16))
    return fn(this)
  }
  vector(reader = this.object, bare = false) {
    if (!bare) {
      const id = this.uint()
      if (id !== VECTOR) throw new Error('TL: expected vector, got 0x' + id.toString(16))
    }
    const n = this.uint()
    const out = new Array(n)
    // generated readers take the reader as their argument; object() must not get one
    const isObject = reader === TlReader.prototype.object
    for (let i = 0; i < n; i++) out[i] = isObject ? this.object() : reader.call(this, this)
    return out
  }
}

export class TlWriter {
  constructor(size = 256) {
    this.buf = new Uint8Array(size)
    this.dv = new DataView(this.buf.buffer)
    this.pos = 0
  }
  _need(n) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const b = new Uint8Array(size)
    b.set(this.buf.subarray(0, this.pos))
    this.buf = b
    this.dv = new DataView(b.buffer)
  }
  uint(v) { this._need(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this }
  int(v) { this._need(4); this.dv.setInt32(this.pos, v | 0, true); this.pos += 4; return this }
  long(v) { this._need(8); this.dv.setBigInt64(this.pos, BigInt.asIntN(64, BigInt(v)), true); this.pos += 8; return this }
  int53(v) { return this.long(BigInt(v)) }
  raw(b) { this._need(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this }
  bytes(b) {
    const len = b.length
    if (len < 254) {
      this._need(len + 4)
      this.buf[this.pos++] = len
      this.raw(b)
      const pad = (len + 1) % 4
      if (pad) { this._need(4 - pad); this.buf.fill(0, this.pos, this.pos + 4 - pad); this.pos += 4 - pad }
    } else {
      this._need(len + 8)
      this.buf[this.pos++] = 254
      this.buf[this.pos++] = len & 255
      this.buf[this.pos++] = (len >> 8) & 255
      this.buf[this.pos++] = (len >> 16) & 255
      this.raw(b)
      const pad = len % 4
      if (pad) { this._need(4 - pad); this.buf.fill(0, this.pos, this.pos + 4 - pad); this.pos += 4 - pad }
    }
    return this
  }
  string(s) { return this.bytes(encoder.encode(s)) }
  vector(items, write) {
    this.uint(VECTOR).uint(items.length)
    for (const it of items) write(this, it)
    return this
  }
  result() { return this.buf.slice(0, this.pos) }
}

const w = (size) => new TlWriter(size)

// ---------- MTProto service / handshake ----------
export const reqPqMulti = (nonce) => w(32).uint(0xbe7e8ef1).raw(nonce).result()
export const pqInnerDataDc = (pq, p, q, nonce, serverNonce, newNonce, dc) =>
  w(160).uint(0xa9f55f95).bytes(pq).bytes(p).bytes(q).raw(nonce).raw(serverNonce).raw(newNonce).int(dc).result()
export const reqDhParams = (nonce, serverNonce, p, q, fingerprint, encrypted) =>
  w(400).uint(0xd712e4be).raw(nonce).raw(serverNonce).bytes(p).bytes(q).long(fingerprint).bytes(encrypted).result()
export const clientDhInnerData = (nonce, serverNonce, retryId, gB) =>
  w(320).uint(0x6643b654).raw(nonce).raw(serverNonce).long(retryId).bytes(gB).result()
export const setClientDhParams = (nonce, serverNonce, encrypted) =>
  w(400).uint(0xf5045f1f).raw(nonce).raw(serverNonce).bytes(encrypted).result()
export const msgsAck = (ids) => w(16 + ids.length * 8).uint(0x62d6b459).vector(ids, (x, id) => x.long(id)).result()
export const ping = (id) => w(12).uint(0x7abe77ec).long(id).result()

// ---------- API ----------
export function invokeWithLayer(query) {
  return w(query.length + 8).uint(0xda9b0d0d).int(LAYER).raw(query).result()
}

export function initConnection(apiId, query) {
  return w(query.length + 128)
    .uint(0xc1cd5ea9).uint(0).int(apiId)
    .string('Cloudflare Worker').string('workerd').string('telemedia-stream 1.0')
    .string('en').string('').string('en')
    .raw(query).result()
}

export const helpGetConfig = () => w(4).uint(0xc4f9186b).result()

export const importBotAuthorization = (apiId, apiHash, token) =>
  w(128).uint(0x67a3ff2c).int(0).int(apiId).string(apiHash).string(token).result()

export const exportAuthorization = (dcId) => w(8).uint(0xe5bfffcd).int(dcId).result()

export const importAuthorization = (id, bytes) => w(bytes.length + 24).uint(0xa57a7dad).long(id).bytes(bytes).result()

const inputChannel = (x, ch) => x.uint(0xf35aec28).int53(ch.id).long(ch.accessHash)

export const channelsGetChannels = (channelId, accessHash) =>
  w(40).uint(0x0a7f6bbb).vector([{ id: channelId, accessHash }], inputChannel).result()

export const channelsGetMessages = (channelId, accessHash, msgIds) => {
  const x = w(64).uint(0xad8c9a23)
  inputChannel(x, { id: channelId, accessHash })
  return x.vector(msgIds, (y, id) => y.uint(0xa676a322).int(id)).result()
}

export const uploadGetFile = (doc, offset, limit) =>
  w(doc.fileReference.length + 64)
    .uint(0xbe5335be).uint(0)
    .uint(0xbad07584).long(doc.id).long(doc.accessHash).bytes(doc.fileReference).string('')
    .int53(offset).int(limit).result()
