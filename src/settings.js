// Settings each deployer enters in the Cloudflare dashboard:
// Workers & Pages -> your Worker -> Settings -> Variables and Secrets.
//
//   APP_URL             required  the app's address, e.g. https://stream.example.com
//   SHARED_SECRET       required  the app's Cloudflare secret, or the one its owner gave you
//   USER_SECRET_<NAME>  optional  one per user of your app you host on this Worker (they stream
//                                 with their own bots); the app has the same secret for them
//   SEGMENT_MB          optional  MB per Durable Object request (default 512; 1 if CPU limits bite)
//   LOCATION_HINT       optional  where the Durable Object is first created: wnam, enam, sam, weur,
//                                 eeur, apac, oc, afr, me (default apac). Only the first creation counts.
//
// Secrets survive every redeploy; plain variables do too because wrangler.toml sets keep_vars.

const HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'])
const DEFAULT_HINT = 'apac'

// The only app this Worker serves: bot settings come from here and usage goes here. Links must
// also be signed with that app's secret. Plain http is accepted only for local tests, because the
// Worker fetches the bot token from this address.
export function appUrl(env) {
  const raw = typeof env.APP_URL === 'string' ? env.APP_URL.trim().replace(/\/+$/, '') : ''
  if (!raw) return ''
  let u
  try {
    u = new URL(raw)
  } catch {
    return ''
  }
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
  if (u.protocol !== 'https:' && !local) return ''
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return ''
  return u.origin
}

export const APP_URL_HELP =
  'APP_URL is not set or not valid on this Worker: add it in Cloudflare (Settings -> Variables and Secrets) ' +
  'as the address of the app, like https://stream.example.com'

export function locationHint(env) {
  const h = typeof env.LOCATION_HINT === 'string' ? env.LOCATION_HINT.trim().toLowerCase() : ''
  return HINTS.has(h) ? h : DEFAULT_HINT
}
