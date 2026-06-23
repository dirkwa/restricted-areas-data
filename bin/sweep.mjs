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
 * Two paths, both retained:
 *
 *  - INCREMENTAL (the weekly default): changedSinceRows pages
 *    search?type=sites_updated&changed_since=<lastSweepDate>&include_inactive=true,
 *    which now reports new sites and corrections as ACTIVE rows and deletions as
 *    status:"removed" rows. deriveDelta classifies them against the carried-forward
 *    mirror; the index is PATCHED (patchIndex), never rebuilt — sites_updated is not
 *    a census (it only returns sites whose last_update is in the window), so the
 *    ~28k untouched baseline must be carried forward. assertSaneDelta caps removals.
 *
 *  - CENSUS (monthly, or on stale/absent baseline / --full): sweepIndex pages the
 *    whole catalog (~55 paced requests); diffIndex + assertSaneSweep as before. The
 *    census is the only self-heal for anything the incremental stream silently
 *    misses (truncated page, sub-cap removal drip) and the only pruner of a site
 *    silently flipped to high-seas. site_major/minor_version moves only on
 *    regulation/boundary changes, so the census still unions a changedSinceRows pass
 *    to catch same-version corrections.
 *
 * Verified live: changed_since is inclusive (>=); sites_updated pagination is stable
 * under sort=NAME_ASC; last_update is day-granular (no time) so a (version,date)
 * equality skip is unsafe — every active in-mirror row is re-fetched, idempotency
 * comes from overwrite.
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

/** A sites_updated row is a deletion only on an explicit removed status. */
export function isRemovedRow(site) {
  return typeof site?.status === 'string' && site.status.toLowerCase() === 'removed'
}

/**
 * Hard gate: confirm include_inactive=true is actually honored, so a silent flag
 * regression can never make us blind to removals or resurrect a deleted site. A
 * non-empty window must carry a `status` field on at least one row (pre-flag
 * responses have no status field at all). Throws otherwise.
 */
export function assertInactiveFlagHonored(reportedRows, sawStatusField) {
  if (reportedRows > 0 && !sawStatusField) {
    throw new Error(
      'sites_updated rows carry no `status` field — include_inactive=true is not in effect ' +
        '(removals would be invisible); refusing to sync'
    )
  }
}

/**
 * Page search?type=sites_updated&changed_since=<date>&include_inactive=true and
 * classify the window. Returns:
 *   active         Map<id, {v,u,hs:false}>  non-high-seas active rows (mirrorable)
 *   removed        Set<id>                  status:"removed" rows (id only; NOT
 *                  country-filtered — a removed row for an unmirrored/high-seas id
 *                  is a no-op downstream)
 *   reclassifiedHs Set<id>                  ACTIVE rows that ARE high-seas (so a
 *                  mirrored site flipped to high-seas can be pruned as removed)
 *   reportedRows   number                   total rows seen (for the flag gate)
 * Active-vs-removed precedence is resolved by deriveDelta (active wins), so page
 * order is irrelevant. Pins sort=NAME_ASC (pagination verified stable under it); a
 * row duplicated across a page boundary is idempotent into the Map/Set.
 */
export async function changedSinceRows(
  getJson,
  changedSince,
  { limit = 500, maxPages = 500 } = {}
) {
  const active = new Map()
  const removed = new Set()
  const reclassifiedHs = new Set()
  let reportedRows = 0
  let sawStatusField = false
  for (let page = 1; page <= maxPages; page++) {
    const res = await getJson(
      `${API_BASE}/search/?type=sites_updated&changed_since=${encodeURIComponent(changedSince)}` +
        `&include_inactive=true&limit=${limit}&page=${page}&sort=NAME_ASC`
    )
    const batch = res?.sites ?? []
    for (const site of batch) {
      const id = String(site.site_id ?? '')
      if (id === '') continue
      reportedRows += 1
      if (typeof site.status === 'string') sawStatusField = true
      if (isRemovedRow(site)) removed.add(id)
      else if (isHighSeasCountry(site.country)) reclassifiedHs.add(id)
      else active.set(id, entryOf(site))
    }
    if (batch.length < limit) {
      assertInactiveFlagHonored(reportedRows, sawStatusField)
      return { active, removed, reclassifiedHs, reportedRows }
    }
  }
  throw new Error(`changed_since did not terminate within ${maxPages} pages — pagination broken?`)
}

/**
 * Classify one changedSinceRows window against the carried-forward mirror. "In the
 * mirror" is index ∪ geometryUnavailable (parked withheld-boundary sites live in
 * the latter, NOT in index). Returns id arrays:
 *   added            active id in NEITHER store (a new site)
 *   changed          active id in index — ALWAYS re-fetched (no version/date skip;
 *                    last_update is day-granular so equality is unsafe)
 *   forceFetchParked active id parked in geometryUnavailable — may now have a
 *                    boundary OR be a same-version coding correction; must NOT be
 *                    routed through partitionAdded's version-unchanged skip
 *   removed          (removed ∪ mirrored reclassifiedHs) MINUS any id also active
 *                    in this window (active wins, order-independent), restricted to
 *                    ids actually present in index or geometryUnavailable
 * A NEW (unmirrored) high-seas active row is dropped entirely (never added).
 */
export function deriveDelta(mirrorIndex, geometryUnavailable, { active, removed, reclassifiedHs }) {
  const idx = mirrorIndex instanceof Map ? mirrorIndex : new Map(Object.entries(mirrorIndex))
  const parked =
    geometryUnavailable instanceof Map
      ? geometryUnavailable
      : new Map(Object.entries(geometryUnavailable ?? {}))
  const inMirror = (id) => idx.has(id) || parked.has(id)

  const added = []
  const changed = []
  const forceFetchParked = []
  for (const id of active.keys()) {
    if (idx.has(id)) changed.push(id)
    else if (parked.has(id)) forceFetchParked.push(id)
    else added.push(id)
  }

  const removedSet = new Set()
  for (const id of removed) if (inMirror(id) && !active.has(id)) removedSet.add(id)
  // An ACTIVE row reclassified to high-seas is, to the mirror, a deletion.
  for (const id of reclassifiedHs) if (inMirror(id) && !active.has(id)) removedSet.add(id)

  return { added, changed, removed: [...removedSet], forceFetchParked }
}

/**
 * Carry the mirror forward and patch it. Returns fresh { index, geometryUnavailable }
 * (inputs untouched). Owns BOTH stores so removals clean both and parked<->indexed
 * transitions stay coherent.
 *   removedIds  ids to delete from BOTH stores
 *   refreshed   Map<id, feature> from fetchDetails (geometry maybe null)
 *   consumed    Set<id> whose OLD shard line was updated in place (so a null-geometry
 *               refresh kept its existing geometry -> stays indexed, not parked)
 *   entryOfId   (id) => {v,u} | undefined  — the window's version/date source
 */
export function patchIndex(
  oldIndex,
  oldGeometryUnavailable,
  { removedIds, refreshed, consumed, entryOfId }
) {
  const index = { ...oldIndex }
  const geometryUnavailable = { ...(oldGeometryUnavailable ?? {}) }
  for (const id of removedIds) {
    delete index[id]
    delete geometryUnavailable[id]
  }
  for (const [id, feature] of refreshed) {
    const e = entryOfId(id)
    const entry = { v: e?.v ?? [null, null], u: e?.u ?? null }
    if (feature.geometry !== null || consumed.has(id)) {
      delete geometryUnavailable[id]
      index[id] = entry
    } else {
      delete index[id]
      geometryUnavailable[id] = { v: entry.v }
    }
  }
  return { index, geometryUnavailable }
}

/**
 * Guard one incremental delta. Census-free: the half-empty check is meaningless (a
 * quiet week legitimately returns ~0 rows) and is dropped. Only REMOVALS (the
 * destructive op) are capped — on the lower of an absolute floor and a ratio — plus
 * a total-delta tripwire that catches a changed_since parse failure replaying all
 * history. Removals are the only DESTRUCTIVE op and get the dedicated cap; adds and
 * changes are bounded only by that gross >50% tripwire (a window touching more than
 * half the mirror is indistinguishable from a parse failure, so it fails loudly —
 * a genuine mass recoding that large is a human decision, not an automatic sync).
 * Under-reporting (a truncated page MISSING changes) is not detectable here — that
 * is what the periodic census heals.
 */
export function assertSaneDelta(
  mirrorSize,
  { added, changed, removed },
  { maxRemovedAbs = 200, maxRemovedRatio = 0.02, maxDeltaRatio = 0.5 } = {}
) {
  if (mirrorSize <= 0) return
  const cap = Math.min(maxRemovedAbs, Math.ceil(mirrorSize * maxRemovedRatio))
  if (removed > cap) {
    throw new Error(
      `incremental window would remove ${removed} of ${mirrorSize} mirrored sites ` +
        `(cap ${cap}) — refusing; investigate upstream first`
    )
  }
  const touched = added + changed + removed
  if (touched > Math.ceil(mirrorSize * maxDeltaRatio)) {
    throw new Error(
      `incremental window touches ${touched} of ${mirrorSize} sites ` +
        `(> ${maxDeltaRatio * 100}%) — implausible for one window; refusing (changed_since parse failure?)`
    )
  }
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
