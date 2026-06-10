#!/usr/bin/env node
/**
 * Fold per-partition seed index fragments into the two mirror metadata files:
 *
 *   mirror-index.json  { SITE_ID -> {v:[major,minor], u:lastUpdate|null} }
 *                      — what sync-mirror diffs against the API sweep.
 *   mirror-state.json  provenance + shard list + counts — human/runbook facing.
 *
 * Usage:
 *   node bin/make-mirror-state.mjs --dataset-date 2026-05-28 \
 *     --download-date 2026-06-02 --seeded-from staging-raw-052826 \
 *     --mirror-dir work/mirror work/mirror/*.index.json
 */

import fs from 'node:fs'
import { basename, join } from 'node:path'

function parseArgs(argv) {
  const out = { fragments: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k.startsWith('--')) {
      out[k.slice(2)] = argv[i + 1]
      i += 1
    } else {
      out.fragments.push(k)
    }
  }
  for (const required of ['dataset-date', 'download-date', 'seeded-from', 'mirror-dir']) {
    if (!out[required]) throw new Error(`missing required --${required}`)
  }
  if (out.fragments.length === 0) throw new Error('no index fragments given')
  return out
}

export function foldFragments(fragments) {
  const sites = {}
  const partitions = []
  for (const fragment of fragments) {
    partitions.push({
      partition: fragment.partition,
      skipped: fragment.skipped === true,
      sites: Object.keys(fragment.sites).length
    })
    Object.assign(sites, fragment.sites)
  }
  return { sites, partitions }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const fragments = args.fragments.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))
  const { sites, partitions } = foldFragments(fragments)

  const shards = fs
    .readdirSync(args['mirror-dir'])
    .filter((n) => n.endsWith('.ndjson.gz'))
    .sort()
    .map((name) => ({
      name,
      bytes: fs.statSync(join(args['mirror-dir'], name)).size
    }))

  const state = {
    schema: 'navigator-download-geojson',
    seededFrom: args['seeded-from'],
    datasetDate: args['dataset-date'],
    downloadDate: args['download-date'],
    lastSweepDate: null,
    siteCount: Object.keys(sites).length,
    partitions,
    shards,
    geometryUnavailable: []
  }

  fs.writeFileSync(join(args['mirror-dir'], 'mirror-index.json'), JSON.stringify(sites) + '\n')
  fs.writeFileSync(
    join(args['mirror-dir'], 'mirror-state.json'),
    JSON.stringify(state, null, 2) + '\n'
  )
  process.stderr.write(
    `mirror-state: ${state.siteCount} sites, ${shards.length} shards (${basename(args['mirror-dir'])})\n`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`)
    process.exitCode = 1
  })
}
