#!/usr/bin/env node
/**
 * Full upstream index sweep + mirror diff.
 *
 * sweepIndex pages through /api/search/?type=sites (no text query returns the
 * whole catalog, ~27k sites at 500/page ≈ 55 paced requests) and builds
 * { SITE_ID -> { v: [major, minor], u: last_update } }. diffIndex compares it
 * to the mirror's index and reports added / changed / removed site ids.
 *
 * Change detection is version-first (the API bumps site_major/minor_version on
 * every attribute or boundary change), with last_update as a belt-and-braces
 * tiebreak when both sides know it. Seed-time mirror entries have u=null (the
 * bulk download carries no last_update column), so the first sync diffs purely
 * on versions.
 *
 * Self-protection: an API anomaly (truncated catalog, half-broken pagination)
 * must never cascade into mass-deleting the mirror. assertSaneSweep throws
 * when the sweep looks implausible relative to the mirror.
 *
 * CLI (ad-hoc inspection):  node bin/sweep.mjs [--limit 500]
 */

import { fileURLToPath } from 'node:url'
import { API_BASE, createApiClient } from './lib/api-client.mjs'

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** One index entry from an API search site object. */
function entryOf(site) {
  return {
    v: [num(site.site_major_version), num(site.site_minor_version)],
    u: typeof site.last_update === 'string' && site.last_update !== '' ? site.last_update : null
  }
}

/** Page through the whole catalog; returns Map<SITE_ID, {v, u}>. */
export async function sweepIndex(getJson, { limit = 500, maxPages = 500 } = {}) {
  const sites = new Map()
  for (let page = 1; page <= maxPages; page++) {
    const res = await getJson(
      `${API_BASE}/search/?type=sites&limit=${limit}&page=${page}&sort=NAME_ASC`
    )
    const batch = res?.sites ?? []
    for (const site of batch) {
      const id = String(site.site_id ?? site.ps_id ?? '')
      if (id !== '') sites.set(id, entryOf(site))
    }
    if (batch.length < limit) return sites
  }
  throw new Error(`sweep did not terminate within ${maxPages} pages — pagination broken?`)
}

function sameVersion(a, b) {
  return a[0] === b[0] && a[1] === b[1]
}

/**
 * Diff mirror index vs sweep index. Both are Map/plain-object of
 * SITE_ID -> {v:[major,minor], u:lastUpdate|null}.
 */
export function diffIndex(mirror, api) {
  const m = mirror instanceof Map ? mirror : new Map(Object.entries(mirror))
  const a = api instanceof Map ? api : new Map(Object.entries(api))
  const added = []
  const changed = []
  const removed = []
  for (const [id, apiEntry] of a) {
    const mirrorEntry = m.get(id)
    if (!mirrorEntry) {
      added.push(id)
      continue
    }
    const versionBump = !sameVersion(mirrorEntry.v, apiEntry.v)
    const dateBump = mirrorEntry.u !== null && apiEntry.u !== null && apiEntry.u > mirrorEntry.u
    if (versionBump || dateBump) changed.push(id)
  }
  for (const id of m.keys()) {
    if (!a.has(id)) removed.push(id)
  }
  return { added, changed, removed }
}

/**
 * Guard against publishing from a broken sweep. Throws when the API returned
 * implausibly few sites or the diff would delete a large slice of the mirror.
 */
export function assertSaneSweep(mirrorSize, apiSize, removedCount, { maxRemovedRatio = 0.1 } = {}) {
  if (mirrorSize > 0 && apiSize < mirrorSize * 0.5) {
    throw new Error(
      `sweep returned ${apiSize} sites but the mirror holds ${mirrorSize} — refusing to sync from a half-empty catalog`
    )
  }
  if (mirrorSize > 0 && removedCount > mirrorSize * maxRemovedRatio) {
    throw new Error(
      `sweep would remove ${removedCount} of ${mirrorSize} mirrored sites (> ${maxRemovedRatio * 100}%) — refusing; investigate upstream first`
    )
  }
}

/** Latest last_update across the sweep — the dataset date of an API-synced release. */
export function maxLastUpdate(api) {
  let max = null
  for (const { u } of api.values()) {
    if (u !== null && (max === null || u > max)) max = u
  }
  return max
}

async function main() {
  const limitArg = process.argv.indexOf('--limit')
  const limit = limitArg === -1 ? 500 : Number(process.argv[limitArg + 1])
  const { getJson, stats } = createApiClient()
  const index = await sweepIndex(getJson, { limit })
  process.stderr.write(`${index.size} sites in ${stats.requests} requests\n`)
  process.stdout.write(JSON.stringify(Object.fromEntries(index)) + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`sweep: ${err.stack ?? err}\n`)
    process.exit(1)
  })
}
