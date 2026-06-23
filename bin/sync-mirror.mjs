#!/usr/bin/env node
/**
 * Mirror sync: keep the canonical dataset mirror current via the public
 * Navigator API, following the upstream-recommended pattern
 * (https://protectedseas.gitbook.io/navigator-api-docs/conventions/data-synchronization).
 *
 *   1. download mirror-index.json (+state) from the draft `mirror` release
 *   2. INCREMENTAL (weekly default): changedSinceRows(lastSweepDate) +
 *      deriveDelta classify added/changed/removed/parked against the carried
 *      mirror; assertSaneDelta caps removals.
 *      CENSUS (~monthly / stale|missing baseline / --full): sweepIndex +
 *      diffIndex + assertSaneSweep, unioning a changed_since pass for
 *      same-version corrections.
 *   3. nothing moved -> advance lastSweepDate (state-only) and stop
 *   4. else: download shards, fetch /api/detail/?export_boundaries=true per
 *      added/changed/parked site (paced), rewrite shards, patchIndex the
 *      carried-forward index + geometryUnavailable, upload, print outputs
 *
 * The index is PATCHED, never rebuilt — sites_updated is not a census. Sites
 * whose boundary the API withholds (MarViva/WDPA/CBD CHM) keep their previously
 * mirrored geometry; new withheld sites park in mirror-state.geometryUnavailable.
 *
 * stdout is GitHub-Actions output lines (changed=, version_tag=, ...);
 * progress goes to stderr. Requires the gh CLI (GH_TOKEN) except in --dry-run.
 * run(argv, deps) takes test seams { gh, makeClient, today, onUpload }.
 *
 * Usage: node bin/sync-mirror.mjs [--mirror-tag mirror] [--work work/sync] [--dry-run true] [--full true]
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { API_BASE, createApiClient } from './lib/api-client.mjs'
import { apiDetailToMirrorFeature } from './lib/api-map.mjs'
import {
  sweepIndex,
  changedSinceRows,
  deriveDelta,
  patchIndex,
  diffIndex,
  assertSaneSweep,
  assertSaneDelta,
  maxLastUpdate
} from './sweep.mjs'

const execFileAsync = promisify(execFile)

const UPDATES_SHARD = 'updates.ndjson.gz'

// A census re-lists the whole catalog (~55 requests); it self-heals anything the
// incremental stream silently missed and prunes silently-flipped high-seas sites.
// Run it ~monthly, on a too-stale baseline, on a missing baseline, or on --full.
const CENSUS_CADENCE_DAYS = 30
const BASELINE_STALE_DAYS = 60

function parseArgs(argv) {
  const out = { 'mirror-tag': 'mirror', work: 'work/sync', 'dry-run': 'false', full: 'false' }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${k}`)
    out[k.slice(2)] = v
  }
  return out
}

/** Whole-day difference between two YYYY-MM-DD dates (b - a). Infinity if a absent. */
export function daysBetween(a, b) {
  if (!a) return Infinity
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : Infinity
}

/**
 * Decide what happens to one existing mirror line during the rewrite.
 * `refreshed` maps SITE_ID -> api feature (geometry possibly null);
 * `removed` is a Set of SITE_IDs; `consumed` collects refreshed ids that found
 * their old record (so leftovers are genuinely new sites).
 */
export function rewriteAction(feature, refreshed, removed, consumed) {
  const id = String(feature?.properties?.SITE_ID ?? feature?.properties?.site_id ?? '')
  if (id !== '' && removed.has(id)) return { action: 'drop' }
  const fresh = id !== '' ? refreshed.get(id) : undefined
  if (!fresh) return { action: 'keep' }
  consumed.add(id)
  return {
    action: 'update',
    feature: fresh.geometry !== null ? fresh : { ...fresh, geometry: feature.geometry }
  }
}

/**
 * Sites whose boundary the API withholds (MarViva/WDPA/CBD CHM sources) wait
 * in mirror-state.geometryUnavailable as { SITE_ID: { v: [major, minor] } }
 * and are only re-fetched when their catalog version moves past the version
 * recorded there — re-fetching 1,600+ known-withheld boundaries every week
 * would burn ~70 min of paced requests for predictable "no geometry" answers.
 * Legacy states stored a bare id array (no versions); adopt the current
 * sweep's versions for those so a future bump still triggers a retry.
 */
export function normalizeGeometryUnavailable(stored, api) {
  if (!stored) return {}
  if (!Array.isArray(stored)) return stored
  const out = {}
  for (const id of stored) {
    const entry = api.get(id)
    if (entry) out[id] = { v: entry.v }
  }
  return out
}

/** Split added ids into ones worth fetching and version-unchanged withheld ones. */
export function partitionAdded(added, api, unavailable) {
  const fetch = []
  const skipped = {}
  for (const id of added) {
    const known = unavailable[id]
    const entry = api.get(id)
    if (known && entry && known.v[0] === entry.v[0] && known.v[1] === entry.v[1]) {
      skipped[id] = { v: entry.v }
    } else {
      fetch.push(id)
    }
  }
  return { fetch, skipped }
}

function sortedByKey(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** Async-iterate the parsed JSON lines of a gzipped NDJSON shard. */
async function* shardLines(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    if (line.trim() !== '') yield JSON.parse(line)
  }
}

function gzipLineWriter(path) {
  const gzip = zlib.createGzip({ level: 6 })
  const out = fs.createWriteStream(path)
  gzip.pipe(out)
  return {
    write: (obj) =>
      new Promise((resolve, reject) =>
        gzip.write(JSON.stringify(obj) + '\n', (err) => (err ? reject(err) : resolve()))
      ),
    // Resolve only when the FILE is fully flushed to disk (out 'finish'), not
    // merely when the gzip transform ends — otherwise a subsequent reader (or
    // the upload) can race a partially-written file.
    end: () =>
      new Promise((resolve, reject) => {
        out.on('finish', resolve)
        out.on('error', reject)
        gzip.end()
      })
  }
}

async function ghReal(args, opts = {}) {
  return execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024, ...opts })
}

async function downloadAssets(gh, tag, dir, patterns) {
  fs.mkdirSync(dir, { recursive: true })
  const patternArgs = patterns.flatMap((p) => ['--pattern', p])
  await gh(['release', 'download', tag, '--dir', dir, '--clobber', ...patternArgs])
}

async function fetchDetails(getJson, ids, onProgress) {
  const refreshed = new Map()
  let done = 0
  for (const id of ids) {
    const detail = await getJson(
      `${API_BASE}/detail/?ps_id=${encodeURIComponent(id)}&export_boundaries=true`
    )
    refreshed.set(id, apiDetailToMirrorFeature(detail))
    done += 1
    if (done % 25 === 0) onProgress(done, ids.length)
  }
  return refreshed
}

function isoToday() {
  return new Date().toISOString().slice(0, 10)
}

function printOutputs(outputs) {
  for (const [k, v] of Object.entries(outputs)) {
    process.stdout.write(`${k}=${String(v)}\n`)
  }
}

function log(msg) {
  process.stderr.write(`${msg}\n`)
}

/**
 * @param {string[]} argv  process args (without node + script)
 * @param {object} [deps]  test seams: { gh, makeClient, today, uploads }
 *   gh         (args) => Promise        — defaults to the real gh CLI runner
 *   makeClient () => { getJson, stats }  — defaults to createApiClient
 *   today      () => 'YYYY-MM-DD'        — defaults to isoToday
 *   onUpload   (paths) => void           — observe the final asset upload (tests)
 */
export async function run(argv = process.argv.slice(2), deps = {}) {
  const gh = deps.gh ?? ghReal
  const makeClient = deps.makeClient ?? createApiClient
  const today = deps.today ?? isoToday
  const args = parseArgs(argv)
  const tag = args['mirror-tag']
  const work = args.work
  const dryRun = args['dry-run'] === 'true'
  const mirrorDir = join(work, 'mirror')

  // Start from a clean workspace: stale shards from an earlier (local or
  // re-run) invocation would be read during the rewrite and re-uploaded.
  fs.rmSync(work, { recursive: true, force: true })

  await downloadAssets(gh, tag, mirrorDir, ['mirror-index.json', 'mirror-state.json'])
  const index = JSON.parse(fs.readFileSync(join(mirrorDir, 'mirror-index.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(join(mirrorDir, 'mirror-state.json'), 'utf8'))
  const mirrorSize = Object.keys(index).length
  log(`mirror: ${mirrorSize} sites (dataset ${state.datasetDate})`)

  const { getJson, stats } = makeClient()

  // Census when forced (--full), when there is no baseline to anchor a window,
  // when the baseline is too stale to trust a single window, or on the monthly
  // cadence. Otherwise the cheap incremental path.
  const baseline = state.lastSweepDate
  const staleDays = daysBetween(baseline, today())
  const censusDays = daysBetween(state.lastFullCensusDate, today())
  const doCensus =
    args.full === 'true' ||
    !baseline ||
    staleDays > BASELINE_STALE_DAYS ||
    censusDays > CENSUS_CADENCE_DAYS

  let added, changed, removedList, forceFetchParked, versionSource

  if (doCensus) {
    const api = await sweepIndex(getJson)
    log(`census sweep: ${api.size} sites in ${stats.requests} requests`)
    const diff = diffIndex(index, api)
    assertSaneSweep(mirrorSize, api.size, diff.removed.length)
    // The census still misses same-version corrections (versions don't move for
    // those); union a changed_since pass when a baseline exists.
    const changedSet = new Set(diff.changed)
    if (baseline) {
      const rows = await changedSinceRows(getJson, baseline)
      for (const id of rows.active.keys()) {
        // Only fold in a correction the census also still lists (apiEntry truthy
        // and non-high-seas). A changed_since-active id absent from the census
        // was removed/reclassified mid-sweep — diffIndex already has it in
        // `removed`; adding it to `changed` would fetch a non-existent site.
        const apiEntry = api.get(id)
        if (index[id] && apiEntry && !apiEntry.hs && !changedSet.has(id)) changedSet.add(id)
      }
      log(`census + changed_since ${baseline}: ${rows.active.size} active rows folded in`)
    }
    added = diff.added
    changed = [...changedSet]
    removedList = diff.removed
    forceFetchParked = []
    versionSource = api
  } else {
    const rows = await changedSinceRows(getJson, baseline)
    log(
      `changed_since ${baseline}: ${rows.reportedRows} rows ` +
        `(${rows.active.size} active, ${rows.removed.size} removed, ${rows.reclassifiedHs.size} ->HS)`
    )
    const delta = deriveDelta(index, state.geometryUnavailable, rows)
    added = delta.added
    changed = delta.changed
    removedList = delta.removed
    forceFetchParked = delta.forceFetchParked
    versionSource = rows.active
    assertSaneDelta(mirrorSize, {
      added: added.length,
      changed: changed.length,
      removed: removedList.length
    })
  }

  const unavailable = normalizeGeometryUnavailable(state.geometryUnavailable, versionSource)
  // Only truly-new ids run through the version-unchanged-withheld skip; parked
  // ids that the window explicitly returned are force-fetched (they may have
  // gained a boundary or be a same-version coding correction).
  const { fetch: addedToFetch, skipped } = partitionAdded(added, versionSource, unavailable)
  log(
    `delta: +${addedToFetch.length} added, ~${changed.length} changed, ` +
      `-${removedList.length} removed, ${forceFetchParked.length} parked re-fetched ` +
      `(${added.length - addedToFetch.length} version-unchanged withheld-boundary skipped)`
  )

  // The dataset date of an API-synced release is the sync date: after a
  // successful sweep + refresh the mirror reflects upstream as of today.
  // maxLastUpdate is only a sanity signal — it can sit BEHIND the bulk
  // extract's date (observed: 2026-04-16 vs extract 2026-05-28), so deriving
  // the date from it would walk the user-visible dataset date backwards.
  const nothingMoved =
    addedToFetch.length + changed.length + removedList.length + forceFetchParked.length === 0
  const datasetDate = nothingMoved ? state.datasetDate : today()
  log(
    `newest upstream last_update${doCensus ? '' : ' in window'}: ${maxLastUpdate(versionSource) ?? 'unknown'}`
  )
  if (nothingMoved || dryRun) {
    // A quiet run still advances the baseline (changed_since is inclusive, so
    // advancing to today never skips a same-day change — the next run re-queries
    // from today) and migrates a legacy id-array geometryUnavailable to the
    // versioned shape. Persist via a state-only upload.
    if (nothingMoved && !dryRun) {
      const statePath = join(mirrorDir, 'mirror-state.json')
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            ...state,
            lastSweepDate: today(),
            lastFullCensusDate: doCensus ? today() : (state.lastFullCensusDate ?? null),
            geometryUnavailable: sortedByKey(unavailable)
          },
          null,
          2
        ) + '\n'
      )
      await gh(['release', 'upload', tag, '--clobber', statePath])
      log('quiet run: advanced lastSweepDate (state-only upload)')
    }
    printOutputs({
      changed: !nothingMoved,
      added: addedToFetch.length,
      updated: changed.length + forceFetchParked.length,
      removed: removedList.length,
      dataset_date: datasetDate,
      version_tag: `v${today().replaceAll('-', '.')}`
    })
    if (dryRun && !nothingMoved) log('dry-run: stopping before detail fetch + rewrite')
    return
  }

  await downloadAssets(gh, tag, mirrorDir, ['*.ndjson.gz'])
  const shardNames = fs.readdirSync(mirrorDir).filter((n) => n.endsWith('.ndjson.gz'))

  const toRefresh = [...addedToFetch, ...changed, ...forceFetchParked]
  log(`fetching ${toRefresh.length} site details (paced, ~${Math.ceil(toRefresh.length / 24)} min)`)
  const refreshed = await fetchDetails(getJson, toRefresh, (done, total) =>
    log(`  ${done}/${total}`)
  )

  const removed = new Set(removedList)
  const consumed = new Set()
  const outDir = join(work, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const updates = gzipLineWriter(join(outDir, UPDATES_SHARD))

  // Rewrite every shard: drop removed lines, update refreshed-in-place (tracking
  // `consumed` so a null-geometry refresh keeps its old geometry and stays
  // indexed), pass the untouched baseline through.
  for (const name of shardNames) {
    const isUpdatesShard = name === UPDATES_SHARD
    const writer = isUpdatesShard ? null : gzipLineWriter(join(outDir, name))
    for await (const feature of shardLines(join(mirrorDir, name))) {
      const { action, feature: out } = rewriteAction(feature, refreshed, removed, consumed)
      if (action === 'drop') continue
      if (action === 'update') await updates.write(out)
      else await (writer ?? updates).write(feature)
    }
    if (writer) await writer.end()
  }

  // Refreshed ids whose old line was NOT consumed are genuinely new lines: write
  // the ones that have geometry; the rest are parked by patchIndex below.
  for (const [id, feature] of refreshed) {
    if (!consumed.has(id) && feature.geometry !== null) await updates.write(feature)
  }
  await updates.end()

  // Carry the mirror forward and patch both stores (removals clean index AND
  // geometryUnavailable; null-geometry refresh parks unless its old line was
  // consumed). Version-unchanged withheld sites skipped this run carry over.
  const { index: newIndex, geometryUnavailable: patchedUnavailable } = patchIndex(
    index,
    state.geometryUnavailable,
    { removedIds: removed, refreshed, consumed, entryOfId: (id) => versionSource.get(id) }
  )
  const newGeometryUnavailable = { ...patchedUnavailable }
  for (const [id, e] of Object.entries(skipped)) {
    if (!newGeometryUnavailable[id]) newGeometryUnavailable[id] = e
  }

  const newState = {
    ...state,
    datasetDate,
    lastSweepDate: today(),
    lastFullCensusDate: doCensus ? today() : (state.lastFullCensusDate ?? null),
    siteCount: Object.keys(newIndex).length,
    shards: fs
      .readdirSync(outDir)
      .filter((n) => n.endsWith('.ndjson.gz'))
      .sort()
      .map((name) => ({ name, bytes: fs.statSync(join(outDir, name)).size })),
    geometryUnavailable: sortedByKey(newGeometryUnavailable)
  }
  fs.writeFileSync(join(outDir, 'mirror-index.json'), JSON.stringify(newIndex) + '\n')
  fs.writeFileSync(join(outDir, 'mirror-state.json'), JSON.stringify(newState, null, 2) + '\n')

  const uploads = fs.readdirSync(outDir).map((n) => join(outDir, n))
  log(`uploading ${uploads.length} assets to draft release '${tag}'`)
  await gh(['release', 'upload', tag, '--clobber', ...uploads])
  deps.onUpload?.(uploads)

  printOutputs({
    changed: true,
    added: addedToFetch.length,
    updated: changed.length + forceFetchParked.length,
    removed: removedList.length,
    dataset_date: datasetDate,
    version_tag: `v${today().replaceAll('-', '.')}`
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    process.stderr.write(`sync-mirror: ${err.stack ?? err}\n`)
    process.exitCode = 1
  })
}
