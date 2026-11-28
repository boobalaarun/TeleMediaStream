// Fixed constants. What each deployer sets (APP_URL, secrets, options) is read from the
// Worker's settings in settings.js.
// __TEST_OVERRIDES__ is only defined by the local test configs; production builds never define
// it, so the values below are the only ones a deployed Worker can use.
/* global __TEST_OVERRIDES__ */
import { TELEGRAM_RSA_KEYS } from './mtproto/rsa-keys.js'

const T = typeof __TEST_OVERRIDES__ !== 'undefined' ? __TEST_OVERRIDES__ : null

export const VERSION = '2.3.0'

// Telegram production data centres (same addresses as pyrofork / Telegram docs)
export const DC_ADDRS = (T && T.dcs) || {
  1: ['149.154.175.53', 443],
  2: ['149.154.167.51', 443],
  3: ['149.154.175.100', 443],
  4: ['149.154.167.91', 443],
  5: ['91.108.56.130', 443],
}

export const RSA_KEYS = ((T && T.rsa) || TELEGRAM_RSA_KEYS).map((k) => ({
  fp: BigInt('0x' + k.fp),
  n: BigInt('0x' + k.n),
  e: BigInt('0x' + k.e),
  old: !!k.old,
}))

export const DH_PRIME_OVERRIDE = T && T.dhPrime ? BigInt('0x' + T.dhPrime) : undefined

// Bytes per Durable Object request. Decryption costs ~6-7 ms CPU per MB, so 512 MB is
// ~3.5 s against the 30 s per-request budget; the front Worker chains segments.
export const SEGMENT_BYTES = (T && T.segmentBytes) || 512 * 1024 * 1024

// File parts requested ahead of the player per stream (1 MB each)
export const PREFETCH = 4

// Re-read bot settings from the app at most this often (or right away on /api/sync)
export const CONFIG_TTL_MS = 10 * 60 * 1000

// Usage / live-stream report interval to the app
export const REPORT_EVERY_MS = (T && T.reportEveryMs) || 15000
