#!/usr/bin/env node
/**
 * Streaming normalizer: ProtectedSeas Navigator GeoJSON -> two NDJSON streams.
 *
 * The input is up to ~3 GB. We NEVER JSON.parse the whole file — stream-json
 * walks the `features` array one feature at a time so memory stays flat.
 *
 * Per feature we: decode props (decode.mjs), apply the LOCKED exclusions from
 * mapping.json.exclude, explode MultiPolygon into component polygons, and emit
 * one normalized GeoJSON Feature per component on each output stream:
 *   - full:    component geometry verbatim
 *   - display: coords rounded to 5 decimals (~1 m), a cheap stand-in for a real
 *              topology-preserving simplify
 *
 * Drop reasons are counted and written to the --exclusions manifest.
 *
 * Usage:
 *   node bin/normalize.mjs --input <file.json> --partition <LFP3|HighSeas|...> \
 *     --out-full <full.ndjson> --out-display <display.ndjson> --exclusions <drops.json>
 *
 * --input omitted or '-' reads from stdin.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import streamJson from 'stream-json'
import Pick from 'stream-json/filters/Pick.js'
import StreamArray from 'stream-json/streamers/StreamArray.js'
import bbox from '@turf/bbox'
import { normalizeProps, categoryIdOf } from './lib/decode.mjs'

// stream-json is CommonJS; its default export carries the factory functions.
const { parser } = streamJson

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXCLUDE = JSON.parse(fs.readFileSync(join(__dirname, '..', 'mapping.json'), 'utf8')).exclude

const DISPLAY_DECIMALS = 5

// FlatGeobuf columns must be scalar — it has no list/struct field type. These
// normalized fields are objects/arrays, so we serialize them to JSON strings on
// write; the plugin's spatial-index parses them back on read. Keep this list in
// sync with FGB_JSON_FIELDS in the plugin's src/spatial-index.ts.
const FGB_JSON_FIELDS = ['restrictions', 'raw', 'sourceUrls', 'siteVersion']

/** Replace object/array fields with JSON strings so ogr2ogr can write a FlatGeobuf. */
function flattenForFgb(properties) {
  const out = { ...properties }
  for (const field of FGB_JSON_FIELDS) {
    if (field in out) out[field] = JSON.stringify(out[field])
  }
  return out
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error('arguments must be --key value pairs')
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`)
    out[k.slice(2)] = argv[i + 1]
  }
  for (const required of ['partition', 'out-full', 'out-display', 'exclusions']) {
    if (!out[required]) throw new Error(`missing required --${required}`)
  }
  return out
}

/** Read marine_area as a number; non-numeric/missing -> null (cannot exceed cap). */
function marineAreaKm2(props) {
  const v = props.marine_area
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A hard transit ban (entry or anchoring prohibited) protects a feature from the area cap. */
function hasHardBan(restrictions) {
  for (const col of EXCLUDE.hardBanColumns) {
    if (restrictions[col] === 'prohibited') return true
  }
  return false
}

/**
 * Decide whether a feature is excluded. Returns a drop-reason string, or null to keep.
 * Partition exclusion is checked once by the caller (it drops the whole stream).
 */
function dropReason(categoryId, props, restrictions) {
  if (EXCLUDE.categoryIds.includes(categoryId)) return 'categoryId'
  const area = marineAreaKm2(props)
  if (area !== null && area > EXCLUDE.maxAreaKm2WithoutHardBan && !hasHardBan(restrictions)) {
    return 'areaWithoutHardBan'
  }
  return null
}

/** Explode a Polygon/MultiPolygon into component Polygon geometries. */
function components(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry]
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
  }
  return []
}

function round(n, decimals) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** Round all [lon,lat] vertices of a Polygon to `decimals` places (display geometry). */
function roundPolygon(geometry, decimals) {
  return {
    type: 'Polygon',
    coordinates: geometry.coordinates.map((ring) =>
      ring.map(([lon, lat]) => [round(lon, decimals), round(lat, decimals)])
    )
  }
}

/**
 * Normalize one raw feature into zero-or-more output records (one per component).
 * Returns { drop } when excluded, or { full: [...], display: [...] } when kept.
 */
function processFeature(feature) {
  const rawProps = feature?.properties ?? {}
  const norm = normalizeProps(rawProps)
  const categoryId = categoryIdOf(rawProps.category_name)
  const reason = dropReason(categoryId, rawProps, norm.restrictions)
  if (reason) return { drop: reason }

  const properties = flattenForFgb(norm)
  const full = []
  const display = []
  components(feature.geometry).forEach((component, componentIndex) => {
    const componentBbox = bbox(component)
    const meta = { componentIndex, bbox: componentBbox, region: null }
    full.push({ type: 'Feature', properties, geometry: component, _meta: meta })
    display.push({
      type: 'Feature',
      properties,
      geometry: roundPolygon(component, DISPLAY_DECIMALS),
      _meta: meta
    })
  })
  return { full, display }
}

function inputStream(input) {
  if (!input || input === '-') return process.stdin
  return fs.createReadStream(input)
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const partition = args.partition ?? 'unknown'
  const outFull = fs.createWriteStream(args['out-full'])
  const outDisplay = fs.createWriteStream(args['out-display'])

  const drops = { categoryId: 0, areaWithoutHardBan: 0, partition: 0 }
  const counts = { featuresIn: 0, kept: 0, componentsFull: 0, componentsDisplay: 0 }

  // Whole-partition exclusion (HighSeas): consume nothing, record the drop, exit.
  if (EXCLUDE.partitions.includes(partition)) {
    drops.partition = 1
    writeJson(args.exclusions, { partition, drops, counts, excludedPartition: true })
    outFull.end()
    outDisplay.end()
    return
  }

  // Stream the features array; the StreamArray transform is the async iterable.
  const features = inputStream(args.input)
    .pipe(parser())
    .pipe(new Pick({ filter: 'features' }))
    .pipe(new StreamArray())

  for await (const { value } of features) {
    counts.featuresIn += 1
    const result = processFeature(value)
    if (result.drop) {
      drops[result.drop] += 1
      continue
    }
    counts.kept += 1
    for (const f of result.full) {
      await write(outFull, f)
      counts.componentsFull += 1
    }
    for (const f of result.display) {
      await write(outDisplay, f)
      counts.componentsDisplay += 1
    }
  }

  await Promise.all([endStream(outFull), endStream(outDisplay)])
  writeJson(args.exclusions, { partition, drops, counts })
}

/** Write one line with backpressure: resolve only when the stream accepts it. */
function write(stream, obj) {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(obj) + '\n', (err) => (err ? reject(err) : resolve()))
  })
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()))
  })
}

function writeJson(path, obj) {
  if (!path) return
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

// Exported for tests; the pure per-feature transform is the testable core.
export {
  processFeature,
  dropReason,
  components,
  roundPolygon,
  marineAreaKm2,
  flattenForFgb,
  FGB_JSON_FIELDS
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`)
    process.exitCode = 1
  })
}
