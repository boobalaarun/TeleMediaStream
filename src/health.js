// Today's health counters for /status and the dashboard, in numbers and in plain words:
// how often Telegram slowed the bot down, how often a Telegram connection went silent (replaced)
// or Telegram stayed silent long enough that a stream was ended so the player asks again, how
// often Cloudflare dropped the link to this Durable Object between segments, how much of
// the streaming time was spent waiting on Telegram rather than on the player, and roughly how
// much of the Free plan's daily allowance this object has used. Counters restart at 00:00 UTC,
// when Cloudflare's daily allowance does. A Worker can't see Cloudflare stopping it for a
// limit (its code doesn't run then), so the allowance figures are an early warning, not a log.

export const FREE_GB_S = 13000 // Durable Object time per day on the Workers Free plan (GB-s)
export const FREE_REQUESTS = 100000 // requests per day on the Workers Free plan
const OBJECT_GB = 0.125 // Cloudflare bills a Durable Object's time at 128 MB
const DAY = 86400000

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const pct = (x) => (x > 0 && x < 0.01 ? 1 : Math.round(x * 100)) // anything above 0 shows as at least 1%

export function emptyDay(day) {
  return {
    day,
    slowdowns: 0, slowdownSeconds: 0, longestSlowdown: 0, slowdownsGivenUp: 0, lastSlowdownAt: 0, lastSlowdownDc: null,
    drops: 0, lastDropAt: 0,
    silentConnections: 0, stalls: 0, lastStallAt: 0,
    requests: 0, activeMs: 0,
    telegramWaitMs: 0, playerWaitMs: 0, bytes: 0,
  }
}

export class Health {
  constructor(now = () => Date.now()) {
    this.now = now
    this.d = emptyDay(dayOf(now()))
    this.busy = 0 // requests or streams running in this object right now
    this.busySince = 0
    this.dirty = false
  }

  // counters saved before a restart, if they are from today
  load(saved) {
    this._roll()
    if (saved && saved.day === this.d.day) this.d = { ...emptyDay(saved.day), ...saved }
  }

  _roll() {
    const t = this.now()
    const day = dayOf(t)
    if (day !== this.d.day) {
      // something running over midnight: its time counts from 00:00 UTC in the new day
      if (this.busy) this.busySince = Math.max(this.busySince, t - (t % DAY))
      this.d = emptyDay(day)
      this.dirty = true
    }
    return t
  }

  // Telegram answered FLOOD_WAIT: `waited` is false when the wait was too long to sit out
  slowdown({ seconds, waited, dc }) {
    const t = this._roll()
    const s = Number(seconds) || 0
    this.d.slowdowns++
    this.d.slowdownSeconds += s
    this.d.longestSlowdown = Math.max(this.d.longestSlowdown, s)
    if (!waited) this.d.slowdownsGivenUp++
    this.d.lastSlowdownAt = t
    this.d.lastSlowdownDc = dc ?? null
    this.dirty = true
  }

  drop() {
    this.d.lastDropAt = this._roll()
    this.d.drops++
    this.dirty = true
  }

  // a Telegram connection received nothing while requests waited: closed and replaced
  silentConnection() {
    this._roll()
    this.d.silentConnections++
    this.dirty = true
  }

  // a stream waited past the stall limit for Telegram and was ended so the player asks again
  stalled() {
    this.d.lastStallAt = this._roll()
    this.d.stalls++
    this.dirty = true
  }

  request() {
    this._roll()
    this.d.requests++
    this.dirty = true
  }

  // Durable Object time is billed while it is busy; enter/leave nest
  enter() {
    const t = this._roll()
    if (this.busy++ === 0) this.busySince = t
  }

  leave() {
    const t = this._roll()
    if (this.busy > 0 && --this.busy === 0) {
      this.d.activeMs += t - this.busySince
      this.dirty = true
    }
  }

  // per part streamed: time spent waiting for Telegram, and for the player to take the bytes
  waits({ telegramMs = 0, playerMs = 0, bytes = 0 }) {
    this._roll()
    this.d.telegramWaitMs += telegramMs
    this.d.playerWaitMs += playerMs
    this.d.bytes += bytes
    this.dirty = true
  }

  snapshot() {
    const t = this._roll()
    const activeMs = this.d.activeMs + (this.busy ? t - this.busySince : 0)
    const gbSeconds = (activeMs / 1000) * OBJECT_GB
    return {
      ...this.d,
      activeMs,
      gbSeconds: Math.round(gbSeconds),
      gbSecondsPct: pct(gbSeconds / FREE_GB_S),
      requestsPct: pct(this.d.requests / FREE_REQUESTS),
      telegramWaitPct: waitPct(this.d.telegramWaitMs, this.d.playerWaitMs),
    }
  }

  // what is saved: finished time only, so a restart never counts the same time twice
  saved() {
    return { ...this.d }
  }
}

// Share of streaming time spent waiting for Telegram (the rest: waiting for the player)
export function waitPct(telegramMs, playerMs) {
  const all = telegramMs + playerMs
  return all > 0 ? Math.round((telegramMs / all) * 100) : null
}

const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC'
const num = (n) => Math.round(n).toLocaleString('en-US')
// 0 → "under a minute", 1344000 → "about 22 minutes", 5400000 → "about 1 h 30 min"
export function duration(ms) {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `about ${min} minute${min === 1 ? '' : 's'}`
  return `about ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
}

// The same counters as sentences, for /status and the dashboard
export function healthLines(h) {
  const lines = []
  if (h.slowdowns) {
    const long = h.slowdownsGivenUp
    lines.push(
      `Telegram slowed the bot down ${times(h.slowdowns)} today (longest ${h.longestSlowdown} s, last at ${hhmm(h.lastSlowdownAt)}` +
      `${h.lastSlowdownDc ? ' on DC ' + h.lastSlowdownDc : ''}). ` +
      (!long ? `The Worker waited ${h.slowdowns === 1 ? 'it' : 'each one'} out.`
        : long === h.slowdowns && long === 1 ? 'It was longer than 15 s, so that stream stopped and the player had to ask again.'
        : `${long === h.slowdowns ? 'All' : long} of them ${long === 1 ? 'was' : 'were'} longer than 15 s, so those streams stopped and the player had to ask again.`),
    )
  } else {
    lines.push('Telegram has not slowed the bot down today.')
  }
  if (h.silentConnections) {
    lines.push(`A Telegram connection went silent ${times(h.silentConnections)} today; the Worker closed it and asked again on a new one.`)
  }
  if (h.stalls) {
    lines.push(`Telegram stayed silent for a whole stream ${times(h.stalls)} today (last at ${hhmm(h.lastStallAt)}), so the Worker ended ` +
      `${h.stalls === 1 ? 'that stream' : 'those streams'} for the player to ask again.`)
  }
  if (h.drops) {
    lines.push(`Cloudflare dropped the link to this Worker's Durable Object ${times(h.drops)} today (last at ${hhmm(h.lastDropAt)}); the stream carried on from the same byte.`)
  }
  if (h.bytes >= 50 * 1048576 && h.telegramWaitPct !== null) {
    lines.push(h.telegramWaitPct >= 50
      ? `While streaming today, the Worker spent ${h.telegramWaitPct}% of the time waiting for Telegram: Telegram was slower than the player.`
      : `While streaming today, the Worker spent ${h.telegramWaitPct}% of the time waiting for Telegram: Telegram kept up with the player.`)
  }
  lines.push(
    `Today so far: the Durable Object was busy for ${duration(h.activeMs)} (${h.gbSecondsPct}% of the Free plan's ` +
    `${Math.round(FREE_GB_S / OBJECT_GB / 3600)} hours a day) and served ${num(h.requests)} requests (${h.requestsPct}% of ${num(FREE_REQUESTS)}).`,
  )
  return lines
}

// The last error, in words, when it is one we know
export function explainError(text) {
  if (!text) return null
  const flood = /FLOOD_(?:PREMIUM_)?WAIT_(\d+)/.exec(text)
  if (flood) return `Telegram asked the bot to wait ${flood[1]} s before downloading more (a slow-down).`
  if (/sent nothing for this stream/.test(text)) return 'Telegram stopped answering for that stream, so the Worker ended it and the player asks again.'
  if (/sent nothing for \d+ s/.test(text)) return 'A Telegram connection went silent; the Worker closed it and asked again on a new one.'
  if (/Network connection lost/i.test(text)) return 'Cloudflare dropped a network link; the player has to ask for the stream again.'
  if (/FILE_REFERENCE_/.test(text)) return 'Telegram said the file link went stale; the Worker re-reads the message and tries again.'
  if (/CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED/.test(text)) return 'The bot cannot read that channel: it must be an admin there.'
  if (/ACCESS_TOKEN|BOT_|AUTH_KEY_UNREGISTERED|USER_DEACTIVATED/.test(text)) return 'Telegram refused the bot (its token was changed or revoked): check the bot in the app, then Sync settings.'
  if (/no connection to Telegram/i.test(text)) return 'The Worker could not reach Telegram.'
  return null
}
