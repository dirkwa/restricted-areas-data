#!/usr/bin/env node
/**
 * Seed one mirror shard from one member of the bulk Navigator download.
 *
 * The mirror is the pipeline's canonical dataset copy: gzipped NDJSON shards
 * (one download-schema GeoJSON Feature per line, one site per feature) plus a
 * compact mirror-index.json, kept current between bulk downloads by
 * sync-mirror.mjs via the public API. Members whose partition is excluded by
 * mapping.json (HighSeas) are not mirrored at all — the build would drop them
 * unconditionally, so mirroring them only costs space. A re-seed from a fresh
 * download is required if that exclusion is ever unlocked.
 *
 * Streaming like normalize.mjs: the biggest member is ~3 GB, never
 * JSON.parse'd whole.
 *
 * Usage:
 *   unzip -p raw.zip <member.json> | node bin/seed-mirror.mjs \
 *     --partition LFP1 --out work/mirror/LFP1.ndjson.gz \
 *     --index-out work/mirror/LFP1.index.json
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import streamJson from 'stream-json'
import Pick from 'stream-json/filters/Pick.js'
import StreamArray from 'stream-json/streamers/StreamArray.js'
import { isExcludedPartition } from './lib/partition.mjs'

const { parser } = streamJson

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EXCLUDE = JSON.parse(fs.readFileSync(join(ROOT, 'mapping.json'), 'utf8')).exclude

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error('arguments must be --key value pairs')
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`)
    out[k.slice(2)] = argv[i + 1]
  }
  for (const required of ['partition', 'out', 'index-out']) {
    if (!out[required]) throw new Error(`missing required --${required}`)
  }
  return out
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Mirror record: the feature as delivered, minus nothing. One line each. */
export function mirrorLine(feature) {
  return JSON.stringify({
    type: 'Feature',
    properties: feature.properties ?? {},
    geometry: feature.geometry ?? null
  })
}

/** Index entry matching sweep.mjs entries; the download has no last_update. */
export function indexEntry(props) {
  return { v: [num(props.site_major_version), num(props.site_minor_version)], u: null }
}

function write(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()))
  })
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()))
  })
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const partition = args.partition

  if (isExcludedPartition(partition, EXCLUDE.partitions)) {
    fs.writeFileSync(
      args['index-out'],
      JSON.stringify({ partition, skipped: true, sites: {} }, null, 2) + '\n'
    )
    process.stderr.write(`${partition}: excluded partition, not mirrored\n`)
    return
  }

  const gzip = zlib.createGzip({ level: 6 })
  gzip.pipe(fs.createWriteStream(args.out))

  const sites = {}
  const input = !args.input || args.input === '-' ? process.stdin : fs.createReadStream(args.input)
  const features = input
    .pipe(parser())
    .pipe(new Pick({ filter: 'features' }))
    .pipe(new StreamArray())

  let count = 0
  for await (const { value } of features) {
    const props = value?.properties ?? {}
    const id = String(props.SITE_ID ?? props.site_id ?? '')
    if (id === '') continue
    sites[id] = indexEntry(props)
    await write(gzip, mirrorLine(value) + '\n')
    count += 1
  }
  await endStream(gzip)

  fs.writeFileSync(args['index-out'], JSON.stringify({ partition, sites }) + '\n')
  process.stderr.write(`${partition}: ${count} sites mirrored\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`)
    process.exitCode = 1
  })
}
