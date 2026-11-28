// MTProto "intermediate" transport over a raw TCP socket: 0xeeeeeeee once, then every
// packet is a 4-byte little-endian length followed by the payload.
// `connect` is cloudflare:sockets' connect() in the Worker (or a Node shim in tests).

export class TransportError extends Error {
  constructor(code) {
    super('Telegram transport error ' + code)
    this.code = code
  }
}

export class Transport {
  constructor(connect, host, port) {
    this.connect = connect
    this.host = host
    this.port = port
    this.closed = false
    this.onPacket = () => {}
    this.onClose = () => {}
    this.lastActivity = Date.now()
    this.lastReceive = Date.now() // last time Telegram sent anything on this connection
  }

  // Fails after `timeoutMs` instead of waiting forever: Cloudflare queues a connection beyond
  // its limit of 6 open ones, and a queued or unanswered connection must not hang a stream.
  async open(timeoutMs = 10000) {
    this.socket = this.connect({ hostname: this.host, port: this.port })
    this.writer = this.socket.writable.getWriter()
    if (this.socket.opened) {
      let timer
      const late = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no connection to Telegram ${this.host}:${this.port} within ${timeoutMs / 1000} s`)),
          timeoutMs,
        )
      })
      try {
        await Promise.race([this.socket.opened, late])
      } catch (e) {
        this.closed = true
        try { this.socket.close() } catch {}
        throw e
      } finally {
        clearTimeout(timer)
      }
    }
    await this.writer.write(new Uint8Array([0xee, 0xee, 0xee, 0xee]))
    this.lastReceive = Date.now()
    this._loop = this._readLoop()
  }

  send(payload) {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    this.lastActivity = Date.now()
    const out = new Uint8Array(payload.length + 4)
    new DataView(out.buffer).setUint32(0, payload.length, true)
    out.set(payload, 4)
    return this.writer.write(out)
  }

  close(err) {
    if (this.closed) return
    this.closed = true
    try { this.socket.close() } catch {}
    this.onClose(err)
  }

  async _readLoop() {
    const reader = this.socket.readable.getReader()
    const chunks = []
    let have = 0
    let need = -1
    const take = (n) => {
      const first = chunks[0]
      if (first.length >= n) {
        const out = first.subarray(0, n)
        if (first.length === n) chunks.shift()
        else chunks[0] = first.subarray(n)
        have -= n
        return out
      }
      const out = new Uint8Array(n)
      let o = 0
      while (o < n) {
        const c = chunks[0]
        const k = Math.min(c.length, n - o)
        out.set(c.subarray(0, k), o)
        o += k
        if (k === c.length) chunks.shift()
        else chunks[0] = c.subarray(k)
      }
      have -= n
      return out
    }
    let error
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value || !value.length) continue
        this.lastActivity = this.lastReceive = Date.now()
        chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value))
        have += value.length
        for (;;) {
          if (need < 0) {
            if (have < 4) break
            const h = take(4)
            need = h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)
            if (need < 0 || need > 16 * 1024 * 1024) throw new Error('bad packet length ' + need)
          }
          if (have < need) break
          const pkt = take(need)
          need = -1
          if (pkt.length === 4) {
            const code = new DataView(pkt.buffer, pkt.byteOffset, 4).getInt32(0, true)
            throw new TransportError(code)
          }
          this.onPacket(pkt)
        }
      }
    } catch (e) {
      error = e
    }
    this.close(error || new Error('connection closed by Telegram'))
  }
}
