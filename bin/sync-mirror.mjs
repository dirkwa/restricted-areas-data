#!/usr/bin/env node
/**
 * Weekly mirror sync: keep the canonical dataset mirror current via the
 * public Navigator API, following the upstream-recommended pattern
 * (https://protectedseas.gitbook.io/navigator-api-docs/conventions/data-synchronization):
 * sweep the catalog index, diff against the mirror, refresh only what moved.
 *
 *   1. download mirror-index.json (+state) from the draft `mirror` release
 *   2. sweepIndex: full SITE_ID -> version catalog (~55 paced requests)
 *   3. diffIndex + assertSaneSweep
 *   4. nothing moved -> print changed=false and stop (shards never downloaded)
 *   5. else: download shards, fetch /api/detail/?export_boundaries=true per
 *      added/changed site (paced), rewrite shards, upload, print outputs
 *
 * Refreshed sites land in the rolling `updates.ndjson.gz` shard; their stale
 * lines are dropped from whichever shard held them. Sites whose boundary the
 * API withholds (MarViva/WDPA/CBD CHM sources) keep their previously mirrored
 * geometry; a NEW site without geometry cannot be rendered or geofenced, so it
 * is skipped and tallied in mirror-state.geometryUnavailable.
 *
 * stdout is GitHub-Actions output lines (changed=, version_tag=, ...);
 * progress goes to stderr. Requires the gh CLI (GH_TOKEN) except in --dry-run.
 *
 * Usage: node bin/sync-mirror.mjs [--mirror-tag mirror] [--work work/sync] [--dry-run true]
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { API_BASE, createApiClient } from './lib/api-client.mjs'
import { apiDetailToMirrorFeature } from './lib/api-map.mjs'
import { sweepIndex, diffIndex, assertSaneSweep, maxLastUpdate } from './sweep.mjs'

const execFileAsync = promisify(execFile)

const UPDATES_SHARD = 'updates.ndjson.gz'

function parseArgs(argv) {
  const out = { 'mirror-tag': 'mirror', work: 'work/sync', 'dry-run': 'false' }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`)
    out[k.slice(2)] = argv[i + 1]
  }
  return out
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
  gzip.pipe(fs.createWriteStream(path))
  return {
    write: (obj) =>
      new Promise((resolve, reject) =>
        gzip.write(JSON.stringify(obj) + '\n', (err) => (err ? reject(err) : resolve()))
      ),
    end: () => new Promise((resolve, reject) => gzip.end((err) => (err ? reject(err) : resolve())))
  }
}

async function gh(args, opts = {}) {
  return execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024, ...opts })
}

async function downloadAssets(tag, dir, patterns) {
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

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const tag = args['mirror-tag']
  const work = args.work
  const dryRun = args['dry-run'] === 'true'
  const mirrorDir = join(work, 'mirror')

  await downloadAssets(tag, mirrorDir, ['mirror-index.json', 'mirror-state.json'])
  const index = JSON.parse(fs.readFileSync(join(mirrorDir, 'mirror-index.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(join(mirrorDir, 'mirror-state.json'), 'utf8'))
  const mirrorSize = Object.keys(index).length
  log(`mirror: ${mirrorSize} sites (dataset ${state.datasetDate})`)

  const { getJson, stats } = createApiClient()
  const api = await sweepIndex(getJson)
  log(`sweep: ${api.size} sites in ${stats.requests} requests`)

  const diff = diffIndex(index, api)
  assertSaneSweep(mirrorSize, api.size, diff.removed.length)
  log(
    `diff: +${diff.added.length} added, ~${diff.changed.length} changed, -${diff.removed.length} removed`
  )

  const datasetDate = maxLastUpdate(api) ?? state.datasetDate
  const nothingMoved = diff.added.length + diff.changed.length + diff.removed.length === 0
  if (nothingMoved || dryRun) {
    printOutputs({
      changed: !nothingMoved,
      added: diff.added.length,
      updated: diff.changed.length,
      removed: diff.removed.length,
      dataset_date: datasetDate,
      version_tag: `v${isoToday().replaceAll('-', '.')}`
    })
    if (dryRun && !nothingMoved) log('dry-run: stopping before detail fetch + rewrite')
    return
  }

  await downloadAssets(tag, mirrorDir, ['*.ndjson.gz'])
  const shardNames = fs.readdirSync(mirrorDir).filter((n) => n.endsWith('.ndjson.gz'))

  const toRefresh = [...diff.added, ...diff.changed]
  log(`fetching ${toRefresh.length} site details (paced, ~${Math.ceil(toRefresh.length / 24)} min)`)
  const refreshed = await fetchDetails(getJson, toRefresh, (done, total) =>
    log(`  ${done}/${total}`)
  )

  const removed = new Set(diff.removed)
  const consumed = new Set()
  const outDir = join(work, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const updates = gzipLineWriter(join(outDir, UPDATES_SHARD))

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

  // Leftover refreshed ids are new sites; without geometry they cannot be
  // rendered or geofenced, so they wait in geometryUnavailable until a future
  // version bump (or bulk re-seed) delivers a boundary.
  const geometryUnavailable = new Set(state.geometryUnavailable ?? [])
  for (const [id, feature] of refreshed) {
    if (consumed.has(id)) {
      geometryUnavailable.delete(id)
      continue
    }
    if (feature.geometry === null) geometryUnavailable.add(id)
    else {
      await updates.write(feature)
      geometryUnavailable.delete(id)
    }
  }
  await updates.end()

  // The new index is the sweep, minus high-seas sites (mirroring the HighSeas
  // partition exclusion) and minus sites still awaiting a boundary — leaving
  // the latter out keeps them "added" so every future sync retries them.
  const newIndex = {}
  for (const [id, entry] of api) {
    if (entry.hs || geometryUnavailable.has(id)) continue
    newIndex[id] = { v: entry.v, u: entry.u }
  }
  const newState = {
    ...state,
    datasetDate,
    lastSweepDate: isoToday(),
    siteCount: Object.keys(newIndex).length,
    shards: fs
      .readdirSync(outDir)
      .filter((n) => n.endsWith('.ndjson.gz'))
      .sort()
      .map((name) => ({ name, bytes: fs.statSync(join(outDir, name)).size })),
    geometryUnavailable: [...geometryUnavailable].sort()
  }
  fs.writeFileSync(join(outDir, 'mirror-index.json'), JSON.stringify(newIndex) + '\n')
  fs.writeFileSync(join(outDir, 'mirror-state.json'), JSON.stringify(newState, null, 2) + '\n')

  const uploads = fs.readdirSync(outDir).map((n) => join(outDir, n))
  log(`uploading ${uploads.length} assets to draft release '${tag}'`)
  await gh(['release', 'upload', tag, '--clobber', ...uploads])

  printOutputs({
    changed: true,
    added: diff.added.length,
    updated: diff.changed.length,
    removed: diff.removed.length,
    dataset_date: datasetDate,
    version_tag: `v${isoToday().replaceAll('-', '.')}`
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    process.stderr.write(`sync-mirror: ${err.stack ?? err}\n`)
    process.exitCode = 1
  })
}
