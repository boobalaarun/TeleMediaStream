// Who this Worker streams for.
//   SHARED_SECRET          -> "main": the app's Cloudflare secret (the app owner's bots), or the
//                             secret an app owner gave you for your account (your own bots)
//   USER_SECRET_<NAME>     -> "<name>": a user of the app hosted on this Worker, streaming with
//                             their own bots; the app has the same secret for that user
// Each one gets its own Durable Object, so every user's Telegram login and limits stay apart.
// The app checks its main secret first, so a user's secret must differ from it (and from
// every other user's); duplicates are ignored here.
export const MAIN = 'main'
const PREFIX = 'USER_SECRET_'

export function tenants(env) {
  const list = []
  let ignored = 0
  const seen = new Set()
  const main = typeof env.SHARED_SECRET === 'string' ? env.SHARED_SECRET : ''
  if (main) {
    list.push({ name: MAIN, secret: main })
    seen.add(main)
  }
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(PREFIX)) continue
    const name = key.slice(PREFIX.length).toLowerCase()
    // The app trims the secret it stores for a user, so trim ours the same way
    const secret = typeof env[key] === 'string' ? env[key].trim() : ''
    if (!secret) continue
    if (!/^[a-z0-9_]{1,32}$/.test(name) || name === MAIN || seen.has(secret)) {
      ignored++
      continue
    }
    seen.add(secret)
    list.push({ name, secret })
  }
  return { list, ignored }
}

export function secretFor(env, name) {
  const t = tenants(env).list.find((x) => x.name === name)
  return t ? t.secret : ''
}

// The main object keeps the name it always had, so its saved Telegram login stays valid
export const objectName = (name) => (name === MAIN ? 'telemedia-core' : 'user:' + name)

// The app's live-stream list ends the streams a Worker stops reporting, keyed by this name.
// Many Workers can report to one app (its owner's and each user's own), and a Worker runs one
// object per user, so the name carries the object's id: no two objects ever share a name.
export const memberName = (name, objectId) =>
  (name === MAIN ? 'telemediastream' : 'telemediastream:' + name) + '#' + String(objectId).slice(0, 12)

export const secretKey = (name) => (name === MAIN ? 'SHARED_SECRET' : PREFIX + name.toUpperCase())
