#!/usr/bin/env node
/**
 * Full upstream index sweep + mirror diff.
 *
 * sweepIndex pages through /api/search/?type=sites (no text query returns the
 * whole catalog, ~27k sites at 500/page ≈ 55 paced requests) and builds
 * { SITE_ID -> { v: [major, minor], u: last_update } }. diffIndex compares it
 * to the mirror's index and reports added / removed site ids (and version/date
 * changes as a fallback).
 *
 * Change detection: the catalog sweep alone is NOT sufficient. Per ProtectedSeas,
 * site_major/minor_version increments only on regulation or boundary changes —
 * NOT on attribute or activity-coding corrections. The reliable signal for those
 * is last_update, which is exactly what changed_since filters on. So the
 * authoritative "what changed" comes from changedSinceIds(getJson, date)
 * (search?type=sites_updated&changed_since=...); the full sweep is still needed
 * for added/removed (sites_updated never reports deletions). Version/date diffing
 * in diffIndex is kept only as a belt-and-braces fallback for the very first run,
 * before any lastSweepDate baseline exists.
 *
 * Self-protection: an API anomaly (truncated catalog, half-broken pagination)
 * must never cascade into mass-deleting the mirror. assertSaneSweep throws
 * when the sweep looks implausible relative to the mirror.
 *
 * CLI (ad-hoc inspection):  node bin/sweep.mjs [--limit 500]
 */

import { fileURLToPath } from 'node:url'
import { API_BASE, createApiClient } from './lib/api-client.mjs'
import { isHighSeasCountry } from './lib/partition.mjs'

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
    u: typeof site.last_update === 'string' && site.last_update !== '' ? site.last_update : null,
    // High-seas RFMO sites mirror the HighSeas partition exclusion: never
    // fetched, never mirrored, never counted as added/changed.
    hs: isHighSeasCountry(site.country)
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
      const id = String(site.site_id ?? '')
      if (id !== '') sites.set(id, entryOf(site))
    }
    if (batch.length < limit) return sites
  }
  throw new Error(`sweep did not terminate within ${maxPages} pages — pagination broken?`)
}

/**
 * Site IDs the API reports as updated on/after `changedSince` (YYYY-MM-DD), via
 * search?type=sites_updated. This is the ONLY signal that catches same-version
 * attribute/coding corrections (versions don't move for those). High-seas sites
 * are excluded — they are never mirrored. Returns a Set<SITE_ID>.
 */
export async function changedSinceIds(getJson, changedSince, { limit = 500, maxPages = 500 } = {}) {
  const ids = new Set()
  for (let page = 1; page <= maxPages; page++) {
    const res = await getJson(
      `${API_BASE}/search/?type=sites_updated&changed_since=${encodeURIComponent(
        changedSince
      )}&limit=${limit}&page=${page}`
    )
    const batch = res?.sites ?? []
    for (const site of batch) {
      const id = String(site.site_id ?? '')
      if (id !== '' && !isHighSeasCountry(site.country)) ids.add(id)
    }
    if (batch.length < limit) return ids
  }
  throw new Error(`changed_since did not terminate within ${maxPages} pages — pagination broken?`)
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
    if (apiEntry.hs) continue
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
    // A mirrored site that upstream reclassified as high-seas must be pruned,
    // not retained — to the mirror it is as gone as a deleted site.
    const apiEntry = a.get(id)
    if (!apiEntry || apiEntry.hs) removed.push(id)
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
  for (const { u, hs } of api.values()) {
    if (hs) continue
    if (u !== null && (max === null || u > max)) max = u
  }
  return max
}

async function main() {
  const limitArg = process.argv.indexOf('--limit')
  let limit = 500
  if (limitArg !== -1) {
    limit = Number(process.argv[limitArg + 1])
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`--limit requires a positive number, got: ${process.argv[limitArg + 1]}`)
    }
  }
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
