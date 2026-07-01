#!/usr/bin/env node
/**
 * check-upstream: decide whether Navigator has a newer dataset than we last
 * published, and open/refresh one tracking issue when it does. Download-free —
 * it only reads the data-access page HTML and our published manifest.json.
 *
 * The upstream date signal: ProtectedSeas stamps the dataset date into the
 * ArcGIS FeatureServer service/layer name linked from the data-access page —
 * e.g. `Navigator_AllSites_042426_attributes` => 2026-04-24 (MMDDYY). That is
 * the authoritative "dataset as of" marker (the page also shows a human-facing
 * `Last update: MM-DD-YYYY` line, used as a fallback / cross-check). The old
 * gated "ISO dataset date on the data-request page" no longer exists after the
 * Navigator V2 rollout.
 *
 * Best-effort by design: a transient upstream hiccup (403/429/5xx from the
 * WordPress/ArcGIS hosts) or a missing/unreadable manifest degrades to
 * "nothing new" (newer=false) rather than failing the monthly workflow.
 */

import { fileURLToPath } from 'node:url'

const DATA_REQUEST_URL = 'https://navigatormap.org/data-request'

const UA = 'restricted-areas-data check-upstream (+https://github.com/dirkwa/restricted-areas-data)'

// The dataset date encoded in the ArcGIS service/layer name: Navigator..._MMDDYY_...
const ARCGIS_NAME_DATE = /Navigator_AllSites_(\d{2})(\d{2})(\d{2})_/g
// The human-facing "Last update: MM-DD-YYYY" line (fallback / cross-check).
const LAST_UPDATE_US = /Last update:\s*(\d{2})-(\d{2})-(\d{4})/g

/** True iff `s` is a real calendar date in strict YYYY-MM-DD form. */
function isValidISO(s) {
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}

/**
 * Normalize a date to strict YYYY-MM-DD, or null if it isn't a valid date.
 * Accepts YYYY-MM-DD (ISO) and a 6-digit MMDDYY (ArcGIS name, 20xx assumed).
 * Defensive: our own manifest is already ISO, but this keeps the comparison
 * total-ordered even if a source format shifts.
 */
export function normalizeDate(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) return isValidISO(s) ? s : null
  const mdY = /^(\d{2})(\d{2})(\d{2})$/.exec(s) // MMDDYY
  if (mdY) {
    const [, mm, dd, yy] = mdY
    const candidate = `20${yy}-${mm}-${dd}`
    return isValidISO(candidate) ? candidate : null
  }
  return null
}

/**
 * Extract the newest dataset date from the data-access page HTML. Prefers the
 * ArcGIS layer-name date; falls back to (and cross-checks against) the
 * "Last update" text. Returns YYYY-MM-DD, or null when nothing recognizable.
 */
export function parseUpstreamDate(html) {
  if (typeof html !== 'string') return null
  const fromName = [...html.matchAll(ARCGIS_NAME_DATE)].map(([, mm, dd, yy]) =>
    normalizeDate(`${mm}${dd}${yy}`)
  )
  const fromText = [...html.matchAll(LAST_UPDATE_US)].map(([, mm, dd, yyyy]) =>
    normalizeDate(`${yyyy}-${mm}-${dd}`)
  )
  const all = [...fromName, ...fromText].filter((d) => d !== null)
  return all.length > 0 ? all.sort().at(-1) : null
}

/** String ISO dates compare correctly lexicographically; null published = always newer. */
export function isNewer(upstream, published) {
  if (!upstream) return false
  if (!published) return true
  return upstream > published
}

/**
 * GET text with a real UA, a timeout, and a small backoff retry for plausibly
 * transient states. Throws on give-up; callers that must not fail the workflow
 * wrap the call.
 */
// 403 included: the WordPress/ArcGIS hosts return it on anti-bot / rate-limit
// blocks, which a paced retry with a real UA can plausibly clear.
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504])

async function fetchText(url, { attempts = 3 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    let res
    try {
      res = await globalThis.fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow'
      })
    } catch (err) {
      lastErr = err // network-layer failure (DNS, timeout) — always retryable
    }
    if (res) {
      if (res.ok) return res.text()
      lastErr = new Error(`${url} -> HTTP ${res.status}`)
      // Fail fast on a non-transient status: don't burn the backoff budget.
      if (!RETRYABLE.has(res.status)) throw lastErr
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i))
  }
  throw lastErr
}

/** Read datasetDate from the latest release's manifest.json via the gh CLI. */
async function publishedDatasetDate(execFileAsync) {
  try {
    const { stdout } = await execFileAsync('gh', [
      'release',
      'view',
      '--json',
      'assets',
      '--jq',
      '.assets[] | select(.name=="manifest.json") | .url'
    ])
    const url = stdout.trim()
    if (!url) return null
    const manifest = JSON.parse(await fetchText(url))
    return normalizeDate(manifest.datasetDate)
  } catch {
    return null
  }
}

async function main() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  // The upstream probe is best-effort: never let a transient fetch failure or a
  // page redesign fail the monthly workflow. Degrade to "no upstream date".
  let upstream = null
  try {
    upstream = parseUpstreamDate(await fetchText(DATA_REQUEST_URL))
  } catch (err) {
    console.error(
      `check-upstream: upstream probe failed, treating as no new dataset: ${err.message}`
    )
  }

  const published = await publishedDatasetDate(execFileAsync)
  const newer = isNewer(upstream, published)

  process.stdout.write(
    [`newer=${newer}`, `upstream_date=${upstream ?? ''}`, `published_date=${published ?? ''}`].join(
      '\n'
    ) + '\n'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-upstream: ${err.message}`)
    process.exit(1)
  })
}
