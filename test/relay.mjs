// The front Worker's relay (a dropped link to the Durable Object is picked up again from the
// next byte) and the health counters behind /status and the dashboard.
import { assert } from './shims.mjs'
import { relay, RETRY_DELAYS_MS, isLinkDrop } from '../src/relay.js'
import { Health, healthLines, explainError, waitPct, FREE_GB_S } from '../src/health.js'

let passed = 0
const ok = (n) => { passed++; console.log('  ok  ' + n) }

// A 3.5 MB "file" with a byte pattern, served in segments like the Durable Object does
const FILE = new Uint8Array(3.5 * 1048576)
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 31 + (i >> 11)) & 255
const SEG = 1048576 + 4096 // segment size, not a multiple of the chunk size on purpose
const CHUNK = 65536

// A segment response whose body may break after `breakAfter` bytes ("Network connection lost.")
function segment(from, end, breakAfter = Infinity, error = 'Network connection lost.') {
  const segEnd = Math.min(end, from + SEG - 1)
  let at = from
  let sent = 0
  const body = new ReadableStream({
    pull(c) {
      if (sent >= breakAfter) { c.error(new Error(error)); return }
      if (at > segEnd) { c.close(); return }
      const n = Math.min(CHUNK, segEnd - at + 1, breakAfter - sent)
      c.enqueue(FILE.slice(at, at + n))
      at += n
      sent += n
    },
  })
  return { ok: true, status: 206, headers: new Map([['x-seg-end', String(segEnd)]]), body, text: async () => '' }
}

function sink({ failAfter = Infinity } = {}) {
  const parts = []
  let got = 0
  let aborted = null
  let closed = false
  const writable = new WritableStream({
    write(chunk) {
      if (got + chunk.length > failAfter) throw new Error('player went away')
      parts.push(chunk)
      got += chunk.length
    },
    close() { closed = true },
    abort(reason) { aborted = reason },
  })
  const bytes = () => {
    const out = new Uint8Array(got)
    let o = 0
    for (const p of parts) { out.set(p, o); o += p.length }
    return out
  }
  return { writable, bytes, state: () => ({ aborted, closed, got }) }
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const noSleep = async () => {}

// 1. no trouble: segments stitched, exact bytes
{
  const start = 1000, end = FILE.length - 1
  const s = sink()
  const calls = []
  const r = await relay({
    first: segment(start, end), start, end, writable: s.writable, sleep: noSleep,
    nextSegment: async (from, to, resumed) => { calls.push({ from, resumed }); return segment(from, to) },
  })
  assert(r.done && same(s.bytes(), FILE.subarray(start, end + 1)), 'stitched bytes exact')
  assert(s.state().closed && calls.every((c) => c.resumed === false) && calls.length === 3, 'plain next segments: ' + JSON.stringify(calls))
  ok('segments are stitched into one exact response')
}

// 2. the link drops twice mid-segment: asked again from the exact next byte, nothing lost or repeated
{
  const start = 0, end = FILE.length - 1
  const s = sink()
  const calls = []
  const drops = []
  const waits = []
  let n = 0
  const r = await relay({
    first: segment(start, end, 300000), start, end, writable: s.writable,
    sleep: async (ms) => { waits.push(ms) },
    onDrop: (why) => drops.push(why),
    nextSegment: async (from, to, resumed) => {
      calls.push({ from, resumed })
      return segment(from, to, ++n === 1 ? 700000 : Infinity)
    },
  })
  assert(r.done && same(s.bytes(), FILE), 'bytes exact after two drops')
  assert(calls[0].from === 300000 && calls[0].resumed === 'link', 'first resume from byte 300000: ' + JSON.stringify(calls[0]))
  assert(calls[1].from === 1000000 && calls[1].resumed === 'link', 'second resume from byte 1000000: ' + JSON.stringify(calls[1]))
  assert(drops.length === 2 && waits[0] === RETRY_DELAYS_MS[0], 'two drops, first wait ' + waits[0])
  ok('a dropped link is picked up again from the next byte (twice), and the player gets every byte once')
}

// 3. a Telegram error in the object is retried too, and marked as not a link drop
{
  const start = 0, end = 2 * 1048576
  const s = sink()
  const calls = []
  const r = await relay({
    first: segment(start, end, 500000, '420 FLOOD_WAIT_40'), start, end, writable: s.writable, sleep: noSleep,
    nextSegment: async (from, to, resumed) => { calls.push({ from, resumed }); return segment(from, to) },
  })
  assert(r.done && same(s.bytes(), FILE.subarray(0, end + 1)), 'exact after a Telegram error')
  assert(calls[0].resumed === 'other', 'marked other: ' + JSON.stringify(calls[0]))
  ok('a long Telegram slow-down in the object is retried from the same byte (not counted as a dropped link)')
}

// 4. no progress at all: gives up after the retry budget and aborts the response
{
  const start = 0, end = FILE.length - 1
  const s = sink()
  let tries = 0
  const r = await relay({
    first: segment(start, end, 100), start, end, writable: s.writable, sleep: noSleep,
    nextSegment: async (from, to) => { tries++; return segment(from, to, 0) },
  })
  assert(r.failed && tries === RETRY_DELAYS_MS.length && s.state().aborted, `gave up after ${tries} tries, aborted`)
  ok(`with no progress it gives up after ${RETRY_DELAYS_MS.length} tries and ends the response`)
}

// 5. the object can't be reached for a moment (throws, then 503), then works
{
  const start = 0, end = 1048576 * 2
  const s = sink()
  let n = 0
  const r = await relay({
    first: segment(start, end, 200000), start, end, writable: s.writable, sleep: noSleep,
    nextSegment: async (from, to) => {
      n++
      if (n === 1) throw Object.assign(new Error('Network connection lost.'), { retryable: true })
      if (n === 2) return { ok: false, status: 503, text: async () => 'busy', headers: new Map() }
      return segment(from, to)
    },
  })
  assert(r.done && same(s.bytes(), FILE.subarray(0, end + 1)), 'exact after the object came back')
  ok('if the object is briefly unreachable (an error, then a 503), it keeps trying and finishes')
}

// 6. a 4xx from the object is final; the player leaving stops everything quietly
{
  const s = sink()
  const r = await relay({
    first: segment(0, 3 * 1048576, 50000), start: 0, end: 3 * 1048576, writable: s.writable, sleep: noSleep,
    nextSegment: async () => ({ ok: false, status: 416, text: async () => 'bad segment', headers: new Map() }),
  })
  assert(r.failed && s.state().aborted, '4xx gives up at once')
  const s2 = sink({ failAfter: 200000 })
  let asked = 0
  const r2 = await relay({
    first: segment(0, FILE.length - 1), start: 0, end: FILE.length - 1, writable: s2.writable, sleep: noSleep,
    nextSegment: async (f, t) => { asked++; return segment(f, t) },
  })
  assert(r2.gone && asked === 0, 'player gone: no more segments asked')
  assert(isLinkDrop('Error: Network connection lost.') && !isLinkDrop('420 FLOOD_WAIT_40'), 'link drop wording')
  ok('a refusal from the object is final, and a player that leaves stops the relay without retries')
}

// 7. health counters: slow-downs, drops, busy time, waits, day rollover, words
{
  let now = Date.parse('2026-11-28T10:00:00Z')
  const h = new Health(() => now)
  h.request(); h.enter(); now += 3600000; h.leave() // one hour busy
  h.slowdown({ seconds: 7, waited: true, dc: 5 })
  h.slowdown({ seconds: 40, waited: false, dc: 5 })
  h.drop()
  h.waits({ telegramMs: 8000, playerMs: 2000, bytes: 60 * 1048576 })
  let s = h.snapshot()
  assert(s.gbSeconds === 450 && s.gbSecondsPct === Math.round(450 / FREE_GB_S * 100), 'one busy hour = 450 GB-s: ' + s.gbSeconds)
  assert(s.slowdowns === 2 && s.longestSlowdown === 40 && s.slowdownsGivenUp === 1 && s.drops === 1 && s.telegramWaitPct === 80, JSON.stringify(s))
  const lines = healthLines(s)
  assert(/slowed the bot down twice today \(longest 40 s, last at 11:00 UTC on DC 5\)\. 1 of them was longer than 15 s/.test(lines[0]), lines[0])
  assert(/dropped the link .* once today .* carried on from the same byte/.test(lines[1]), lines[1])
  assert(/80% of the time waiting for Telegram: Telegram was slower than the player/.test(lines[2]), lines[2])
  assert(/about 450 GB-s of Durable Object time \(3% of the Free plan's 13,000\) and 1 requests \(1% of 100,000\)/.test(lines[3]), lines[3])
  // saved and loaded after a restart the same day; a new day starts from zero
  const h2 = new Health(() => now)
  h2.load(h.saved())
  assert(h2.snapshot().slowdowns === 2, 'loaded after restart')
  now = Date.parse('2026-11-29T00:00:05Z')
  const fresh = h2.snapshot()
  assert(fresh.slowdowns === 0 && fresh.day === '2026-11-29', 'new day')
  assert(healthLines(fresh)[0] === 'Telegram has not slowed the bot down today.', 'quiet day wording')
  // busy across midnight counts from 00:00 in the new day
  const h3 = new Health(() => now)
  now = Date.parse('2026-11-29T23:59:00Z'); h3.enter()
  now = Date.parse('2026-11-30T00:01:00Z'); h3.leave()
  assert(h3.snapshot().activeMs === 60000, 'midnight split: ' + h3.snapshot().activeMs)
  assert(waitPct(0, 0) === null && /wait 40 s/.test(explainError('420 FLOOD_WAIT_40')) && /dropped the link/.test(explainError('Network connection lost.')), 'explain')
  ok('health counters: slow-downs, dropped links, Telegram vs player, Free-plan share, restarts and midnight, in words')
}

console.log(`\nrelay + health: ${passed} groups passed`)
