// Bytes sent per UTC hour, for the dashboard: { [hour]: bytes } with hour = floor(ms / 3600000).
// Kept for 48 hours in each Durable Object's storage.
const HOUR = 3600000
const DAY = 86400000
export const KEEP_HOURS = 48

export const hourOf = (ms) => Math.floor(ms / HOUR)

export function addBytes(map, bytes, now = Date.now()) {
  const h = hourOf(now)
  map[h] = (map[h] || 0) + bytes
  return map
}

// Adds `from` into `into` and drops hours older than KEEP_HOURS
export function mergeHours(into, from, now = Date.now()) {
  for (const [h, n] of Object.entries(from)) into[h] = (into[h] || 0) + n
  const oldest = hourOf(now) - KEEP_HOURS
  for (const h of Object.keys(into)) if (Number(h) < oldest) delete into[h]
  return into
}

// today: bytes since 00:00 UTC (when Cloudflare's daily Free allowance resets);
// hours: the last 24 hours, oldest first, the current hour last; firstHour: the hour of hours[0]
export function summarize(map, now = Date.now()) {
  const current = hourOf(now)
  const dayStart = hourOf(now - (now % DAY))
  const hours = []
  for (let h = current - 23; h <= current; h++) hours.push(map[h] || 0)
  let today = 0
  for (const [h, n] of Object.entries(map)) if (Number(h) >= dayStart && Number(h) <= current) today += n
  return { today, hours, firstHour: current - 23 }
}
