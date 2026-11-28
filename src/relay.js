// Copies a stream from the Durable Object into the player's response, segment by segment.
// Cloudflare sometimes drops the link to a Durable Object mid-stream ("Network connection
// lost": a transient error it says to retry). Then the rest is asked for again from the very
// next byte, so the player only sees a short pause instead of a broken stream. A Telegram
// error in the object (for example a long slow-down) is retried the same way. It gives up after
// RETRY_DELAYS_MS.length tries in a row that bring less than 1 MB.

export const RETRY_DELAYS_MS = [300, 1000, 2500, 5000, 8000]
const PROGRESS = 1048576 // bytes that count as "it worked again": the try counter restarts

// Cloudflare's own words for a dropped link to a Durable Object (versus an error from Telegram)
export const isLinkDrop = (why) => /network connection lost|connection (closed|reset)|disconnected|no longer active/i.test(String(why || ''))

/**
 * first: the object's Response for the first segment (x-seg-end header)
 * start, end: the byte range the player asked for (inclusive)
 * nextSegment(from, end, resumed): fetches the next segment; resumed is false for a plain next
 *   segment, 'link' after Cloudflare dropped the link, 'other' after any other interruption
 * writable: the player's response body
 * Returns { done } | { gone } (the player stopped) | { failed } (gave up; the response is aborted)
 */
export async function relay({ first, start, end, nextSegment, writable, sleep, log = () => {}, onDrop = () => {} }) {
  const writer = writable.getWriter()
  let res = first
  let segEnd = Number(first.headers.get('x-seg-end'))
  let pos = start // the next byte the player needs
  let tries = 0
  let failedAt = -Infinity

  // A try that ends without the bytes we need: wait, then ask again (or give up)
  const retry = async (why) => {
    if (pos - failedAt >= PROGRESS) tries = 0
    failedAt = pos
    if (tries >= RETRY_DELAYS_MS.length) return false
    const wait = RETRY_DELAYS_MS[tries++]
    log(`stream interrupted at byte ${pos} (${why}); asking again from there in ${wait} ms (try ${tries} of ${RETRY_DELAYS_MS.length})`)
    await sleep(wait)
    return true
  }

  const giveUp = async (err) => {
    log(`stream stopped at byte ${pos}: ${err && err.message ? err.message : err}`)
    try { await writer.abort(err) } catch {}
    return { failed: true, pos }
  }

  for (;;) {
    // 1. pass this segment's bytes on, counting them
    let broke = null
    const reader = res.body.getReader()
    for (;;) {
      let r
      try {
        r = await reader.read()
      } catch (e) {
        broke = e
        break
      }
      if (r.done) break
      try {
        await writer.write(r.value)
      } catch {
        reader.cancel().catch(() => {}) // the player closed the connection or seeked: not an error
        return { gone: true, pos }
      }
      pos += r.value.byteLength
    }

    // 2. finished the whole range?
    if (!broke && pos > end) {
      try { await writer.close() } catch {}
      return { done: true, pos }
    }

    // 3. a segment ended early or broke: ask again from `pos`; a finished segment: ask for the next
    let resumed = false
    if (broke || pos <= segEnd) {
      const why = broke ? String(broke.message || broke) : 'segment ended early'
      onDrop(why)
      if (!(await retry(why))) return giveUp(broke || new Error(why))
      resumed = isLinkDrop(why) ? 'link' : 'other'
    }
    for (;;) {
      let err
      try {
        res = await nextSegment(pos, end, resumed)
        if (res.ok) break
        const text = await res.text().catch(() => '')
        err = new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`)
        if (res.status < 500) return giveUp(err) // the object refused it: trying again won't help
      } catch (e) {
        err = e
      }
      const why = String(err.message || err)
      if (!(await retry(why))) return giveUp(err)
      resumed = isLinkDrop(why) ? 'link' : resumed || 'other'
    }
    segEnd = Number(res.headers.get('x-seg-end'))
  }
}
