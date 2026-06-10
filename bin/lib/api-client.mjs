/**
 * Paced client for the public Navigator Map API V2.
 *
 * The API is open (no auth) but rate-limited to 5 requests per 10 seconds per
 * IP; exceeding it gets the IP temporarily blocked. Every request in the sync
 * pipeline goes through one shared client that serializes calls and spaces
 * them at 2.5 s (4 per 10 s), leaving headroom for clock skew on the server
 * side. 429/5xx responses retry with exponential backoff.
 */

import { setTimeout as delay } from 'node:timers/promises'

export const API_BASE = 'https://map.navigatormap.org/api'

const USER_AGENT =
  'restricted-areas-data sync (github.com/dirkwa/restricted-areas-data; dirkwahrheit@gmail.com)'

const DEFAULTS = {
  intervalMs: 2500,
  retries: 4,
  backoffBaseMs: 5000,
  rateLimitPauseMs: 30000
}

/**
 * Create a getJson(url) that paces, retries, and parses. Calls are serialized:
 * a request never starts sooner than `intervalMs` after the previous one began.
 * `fetchImpl`/`sleepImpl` are injectable for tests.
 */
export function createApiClient({
  fetchImpl = globalThis.fetch,
  sleepImpl = delay,
  intervalMs = DEFAULTS.intervalMs,
  retries = DEFAULTS.retries,
  backoffBaseMs = DEFAULTS.backoffBaseMs,
  rateLimitPauseMs = DEFAULTS.rateLimitPauseMs,
  now = () => Date.now()
} = {}) {
  let chain = Promise.resolve()
  let lastStart = -Infinity
  const stats = { requests: 0, retries: 0 }

  async function pacedOnce(url) {
    const wait = lastStart + intervalMs - now()
    if (wait > 0) await sleepImpl(wait)
    lastStart = now()
    stats.requests += 1
    return fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  }

  async function getWithRetry(url) {
    for (let attempt = 0; ; attempt++) {
      let res = null
      let err = null
      try {
        res = await pacedOnce(url)
      } catch (e) {
        err = e
      }
      if (res?.ok) return res.json()
      const retryable = err !== null || res.status === 429 || res.status >= 500
      if (!retryable || attempt >= retries) {
        throw err ?? new Error(`${url} -> HTTP ${res.status}`)
      }
      stats.retries += 1
      const pause = res?.status === 429 ? rateLimitPauseMs : backoffBaseMs * 2 ** attempt
      await sleepImpl(pause)
    }
  }

  function getJson(url) {
    // Serialize through the chain so concurrent callers cannot bypass pacing.
    const result = chain.then(() => getWithRetry(url))
    chain = result.catch(() => {})
    return result
  }

  return { getJson, stats }
}
