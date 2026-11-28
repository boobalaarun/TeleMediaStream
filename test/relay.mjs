// The front Worker's relay (segments copied by the runtime; a failed next segment asked again
// from its exact first byte) and the health counters behind /status and the dashboard.
import { assert } from './shims.mjs'
import { relay, RETRY_DELAYS_MS, isLinkDrop } from '../src/relay.js'
import { Health, healthLines, explainError, waitPct, duration, FREE_GB_S } from '../src/health.js'

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

// 1. no trouble: segments stitched, exact bytes, closed at the end
{
  const end = FILE.length - 1
  const s = sink()
  const calls = []
  const r = await relay({
    first: segment(1000, end), end, writable: s.writable, sleep: noSleep,
    nextSegment: async (from, to, resumed) => { calls.push({ from, resumed }); return segment(from, to) },
  })
  assert(r.done && same(s.bytes(), FILE.subarray(1000, end + 1)), 'stitched bytes exact')
  assert(s.state().closed && calls.every((c) => c.resumed === false) && calls.length === 3, 'plain next segments: ' + JSON.stringify(calls))
  ok('segments are stitched into one exact response')
}

// 2. the link drops mid-segment: the byte count is unknown, so the response ends (no resume)
{
  const end = FILE.length - 1
  const s = sink()
  const logs = []
  let asked = 0
  const r = await relay({
    first: segment(0, end, 300000), end, writable: s.writable, sleep: noSleep, log: (m) => logs.push(m),
    nextSegment: async (f, t) => { asked++; return segment(f, t) },
  })
  assert(r.ended && r.why === 'Network connection lost.' && asked === 0, 'ended, nothing asked again: ' + JSON.stringify(r))
  assert(s.state().aborted && !s.state().closed && s.state().got === 300000, 'response aborted after the bytes that came: ' + JSON.stringify(s.state()))
  assert(logs.length === 1 && /unknown byte \(Network connection lost\.\)/.test(logs[0]), 'logged: ' + logs[0])
  ok('a link dropped mid-segment ends the response (the player asks again), and says so in the log')
}

// 3. a Telegram error in the object mid-segment ends the response too, without the link-drop log
{
  const s = sink()
  const logs = []
  const r = await relay({
    first: segment(0, 2 * 1048576, 500000, '420 FLOOD_WAIT_40'), end: 2 * 1048576, writable: s.writable, sleep: noSleep,
    log: (m) => logs.push(m), nextSegment: async () => { throw new Error('not asked') },
  })
  assert(r.ended && /FLOOD_WAIT_40/.test(r.why) && s.state().aborted && logs.length === 0, JSON.stringify({ r, logs }))
  ok('a long Telegram slow-down in the object ends that response (not logged as a dropped link)')
}

// 4. the next segment can't be had for a moment (a dropped link, then a 503): asked again from
//    the exact byte where it starts, marked as a link drop and then as another error
{
  const end = 1048576 * 2
  const s = sink()
  const calls = []
  const waits = []
  let n = 0
  const r = await relay({
    first: segment(0, end), end, writable: s.writable, sleep: async (ms) => { waits.push(ms) },
    nextSegment: async (from, to, resumed) => {
      calls.push({ from, resumed })
      n++
      if (n === 1) throw new Error('Network connection lost.')
      if (n === 2) return { ok: false, status: 503, text: async () => 'busy', headers: new Map() }
      return segment(from, to)
    },
  })
  assert(r.done && same(s.bytes(), FILE.subarray(0, end + 1)), 'exact after the object came back')
  assert(calls.every((c) => c.from === SEG) && calls.map((c) => c.resumed).join() === 'false,link,other', 'tries: ' + JSON.stringify(calls))
  assert(waits.join() === RETRY_DELAYS_MS.slice(0, 2).join(), 'waits ' + waits)
  ok('a next segment that fails (dropped link, then 503) is asked again from its exact first byte')
}

// 5. the next segment keeps failing: gives up after the retry budget and aborts the response
{
  const s = sink()
  let tries = 0
  const r = await relay({
    first: segment(0, FILE.length - 1), end: FILE.length - 1, writable: s.writable, sleep: noSleep,
    nextSegment: async () => { tries++; return { ok: false, status: 500, text: async () => 'boom', headers: new Map() } },
  })
  assert(r.failed && tries === RETRY_DELAYS_MS.length + 1 && s.state().aborted && s.state().got === SEG, `gave up after ${tries} tries, aborted`)
  ok(`a next segment that keeps failing is given up after ${RETRY_DELAYS_MS.length} retries and the response ends`)
}

// 6. a 4xx from the object is final; an overloaded object isn't retried; a player that leaves
//    ends everything quietly
{
  const s = sink()
  let asked = 0
  const r = await relay({
    first: segment(0, 3 * 1048576), end: 3 * 1048576, writable: s.writable, sleep: noSleep,
    nextSegment: async () => { asked++; return { ok: false, status: 416, text: async () => 'bad segment', headers: new Map() } },
  })
  assert(r.failed && s.state().aborted && asked === 1, '4xx gives up at once')
  const s1 = sink()
  let asked1 = 0
  const r1 = await relay({
    first: segment(0, 3 * 1048576), end: 3 * 1048576, writable: s1.writable, sleep: noSleep,
    nextSegment: async () => { asked1++; throw Object.assign(new Error('Durable Object is overloaded'), { overloaded: true }) },
  })
  assert(r1.failed && asked1 === 1, 'overloaded: not retried')
  const s2 = sink({ failAfter: 200000 })
  let asked2 = 0
  const logs = []
  const r2 = await relay({
    first: segment(0, FILE.length - 1), end: FILE.length - 1, writable: s2.writable, sleep: noSleep, log: (m) => logs.push(m),
    nextSegment: async (f, t) => { asked2++; return segment(f, t) },
  })
  assert(r2.ended && asked2 === 0 && logs.length === 0, 'player gone: no more segments asked, nothing logged')
  assert(isLinkDrop('Error: Network connection lost.') && !isLinkDrop('420 FLOOD_WAIT_40'), 'link drop wording')
  ok('a refusal or an overloaded object is final, and a player that leaves ends the relay quietly')
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
  assert(/slowed the bot down twice today \(longest 40 s, last at 11:00 UTC on DC 5\)\. 1 of them was longer than 15 s, so those streams stopped and the player had to ask again\./.test(lines[0]), lines[0])
  assert(/dropped the link .* once today .* carried on from the same byte/.test(lines[1]), lines[1])
  assert(/80% of the time waiting for Telegram: Telegram was slower than the player/.test(lines[2]), lines[2])
  assert(lines[3] === "Today so far: the Durable Object was busy for about 1 h (3% of the Free plan's 29 hours a day) and served 1 requests (1% of 100,000).", lines[3])
  assert(duration(0) === 'under a minute' && duration(60000) === 'about 1 minute' && duration(1344000) === 'about 22 minutes' && duration(5400000) === 'about 1 h 30 min', 'durations')
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
  assert(waitPct(0, 0) === null && /wait 40 s/.test(explainError('420 FLOOD_WAIT_40')) && /player has to ask for the stream again/.test(explainError('Network connection lost.')), 'explain')
  ok('health counters: slow-downs, dropped links, Telegram vs player, Free-plan share, restarts and midnight, in words')
}

console.log(`\nrelay + health: ${passed} groups passed`)
