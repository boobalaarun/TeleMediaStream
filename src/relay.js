// Copies a stream from the Durable Object into the player's response, segment by segment.
//
// The bytes are copied by the Workers runtime itself (pipeTo between two of its own streams):
// no JavaScript runs per chunk, so a whole film costs this Worker almost no CPU time. That is
// the point. A Free-plan Worker gets 10 ms of CPU per request, and 2.2.0 copied in a JavaScript
// loop that counted every chunk (so it could resume after a dropped link): it used 1.8 s of CPU
// in 12 minutes of a film, and Cloudflare stopped the stream ("Worker exceeded CPU time limit").
//
// The price: if the link to the Durable Object drops in the middle of a segment, nobody knows how
// many bytes reached the player, so the response ends and the player asks again from where it
// is. Where the position is known, at the start of every next segment, a failed request is tried
// again (up to RETRY_DELAYS_MS.length times) with a new stub each time.

export const RETRY_DELAYS_MS = [300, 1000, 2500, 5000, 8000]

// Cloudflare's own words for a dropped link to a Durable Object (versus an error from Telegram)
export const isLinkDrop = (why) => /network connection lost|connection (closed|reset)|disconnected|no longer active/i.test(String(why || ''))

const words = (e) => String(e && e.message ? e.message : e)

/**
 * first: the object's Response for the first segment (x-seg-end header)
 * end: the last byte the player asked for (inclusive)
 * nextSegment(from, end, resumed): fetches the segment that starts at `from`; resumed is false
 *   for a plain next segment, 'link' when the try before failed on a dropped link, else 'other'
 * writable: the player's response body
 * Returns { done } | { ended, why } (the player left, or a segment broke: the response ends here)
 *   | { failed, why } (no next segment could be had: the response is aborted)
 */
export async function relay({ first, end, nextSegment, writable, sleep, log = () => {} }) {
  let res = first
  let segEnd = Number(first.headers.get('x-seg-end'))

  const giveUp = async (err) => {
    log(`stream stopped before byte ${segEnd + 1}: ${words(err)}`)
    try { await writable.abort(err) } catch {}
    return { failed: true, why: words(err) }
  }

  for (;;) {
    // 1. this segment's bytes, copied by the runtime
    try {
      await res.body.pipeTo(writable, { preventClose: true })
    } catch (e) {
      // The player closed the connection (it stopped or seeked), or the object's stream broke.
      // The runtime already ended the other side; nothing can be resumed without a byte count.
      const why = words(e)
      if (isLinkDrop(why)) log(`stream ended at an unknown byte (${why}): the link to the Durable Object dropped, or the player went away`)
      try { await writable.abort(e) } catch {}
      return { ended: true, why }
    }

    // 2. the whole range sent?
    if (segEnd >= end) {
      try { await writable.close() } catch {}
      return { done: true }
    }

    // 3. the next segment starts at an exact, known byte: a failed request is tried again
    const from = segEnd + 1
    let resumed = false
    let tries = 0
    for (;;) {
      let err
      try {
        const r = await nextSegment(from, end, resumed)
        if (r.ok) {
          res = r
          break
        }
        const text = await r.text().catch(() => '')
        err = new Error(`HTTP ${r.status}${text ? ': ' + text.slice(0, 200) : ''}`)
        if (r.status < 500) return giveUp(err) // the object refused it: trying again won't help
      } catch (e) {
        err = e
        if (e && e.overloaded) return giveUp(e) // Cloudflare says not to retry an overloaded object
      }
      if (tries >= RETRY_DELAYS_MS.length) return giveUp(err)
      const wait = RETRY_DELAYS_MS[tries++]
      resumed = isLinkDrop(words(err)) ? 'link' : 'other'
      log(`next segment from byte ${from} failed (${words(err)}); trying again in ${wait} ms (try ${tries} of ${RETRY_DELAYS_MS.length})`)
      await sleep(wait)
    }
    segEnd = Number(res.headers.get('x-seg-end'))
  }
}
