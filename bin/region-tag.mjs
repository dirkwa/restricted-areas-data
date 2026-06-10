#!/usr/bin/env node
/**
 * region-tag: route normalized component features into per-region buckets.
 *
 * Reads normalized NDJSON (one GeoJSON Feature per line) from stdin or --input
 * and writes one NDJSON file per region under --outdir. Each feature is assigned
 * to exactly one region by testing its bbox-centroid against regions.geojson in
 * array order; the first containing region wins (ties broken by region order).
 *
 * Upstream (normalize) has already exploded MultiPolygons into single-component
 * features, so a feature's bbox is a tight envelope around one ring set and its
 * centroid is meaningful. A centroid whose source bbox spans the antimeridian
 * resolves to sw-pacific (the only antimeridian-aware region). Features matching
 * no region are written to an `other` bucket and counted, never dropped.
 */

import { createReadStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REGIONS = join(HERE, '..', 'regions', 'regions.geojson')

const OTHER = 'other'

function parseArgs(argv) {
  const args = { input: null, outdir: null, regions: DEFAULT_REGIONS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') args.input = argv[++i]
    else if (a === '--outdir') args.outdir = argv[++i]
    else if (a === '--regions') args.regions = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.outdir) throw new Error('missing required --outdir')
  return args
}

/**
 * Ray-casting point-in-ring. `ring` is a closed array of [lon, lat]. Returns
 * true when [x, y] is strictly inside or on the boundary's even-odd interior.
 */
function pointInRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Point-in-polygon with holes: inside an outer ring and outside every hole. */
function pointInPolygon(x, y, rings) {
  if (rings.length === 0 || !pointInRing(x, y, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i])) return false
  }
  return true
}

function pointInGeometry(x, y, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(x, y, geometry.coordinates)
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygon(x, y, poly))
  }
  return false
}

function loadRegions(path) {
  const fc = JSON.parse(readFileSync(path, 'utf8'))
  return fc.features.map((f) => ({ region: f.properties.region, geometry: f.geometry }))
}

/**
 * Compute [bbox, centroid] from a feature's geometry rings. A bbox spanning the
 * antimeridian (covering both far-west and far-east longitudes with nothing in
 * the middle) is flagged so the caller can route it to sw-pacific instead of
 * trusting a centroid that would fall in the wrong ocean.
 */
function envelope(geometry) {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  const visit = (rings) => {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  if (geometry.type === 'Polygon') visit(geometry.coordinates)
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(visit)

  const centroid = [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
  // A genuine single component never legitimately spans ~the whole globe; a
  // >180deg longitudinal extent means the ring set straddles +/-180.
  const spansAntimeridian = maxLon - minLon > 180
  return { centroid, spansAntimeridian }
}

function regionFor(feature, regions) {
  const { centroid, spansAntimeridian } = envelope(feature.geometry)
  if (spansAntimeridian) return 'sw-pacific'
  const [lon, lat] = centroid
  for (const r of regions) {
    if (pointInGeometry(lon, lat, r.geometry)) return r.region
  }
  return OTHER
}

class RegionWriters {
  constructor(outdir) {
    this.outdir = outdir
    this.streams = new Map()
    this.counts = new Map()
  }
  write(region, line) {
    let stream = this.streams.get(region)
    if (!stream) {
      stream = createWriteStream(join(this.outdir, `${region}.ndjson`))
      this.streams.set(region, stream)
      this.counts.set(region, 0)
    }
    stream.write(line + '\n')
    this.counts.set(region, this.counts.get(region) + 1)
  }
  async close() {
    await Promise.all(
      [...this.streams.values()].map(
        (s) => new Promise((resolve, reject) => s.end((err) => (err ? reject(err) : resolve())))
      )
    )
  }
}

async function run(args) {
  mkdirSync(args.outdir, { recursive: true })
  const regions = loadRegions(args.regions)
  const writers = new RegionWriters(args.outdir)
  const source = args.input ? createReadStream(args.input) : process.stdin
  const rl = createInterface({ input: source, crlfDelay: Infinity })

  for await (const raw of rl) {
    const line = raw.trim()
    if (line === '') continue
    const feature = JSON.parse(line)
    writers.write(regionFor(feature, regions), line)
  }
  await writers.close()

  const summary = Object.fromEntries([...writers.counts.entries()].sort())
  if (summary[OTHER]) {
    console.error(`region-tag: ${summary[OTHER]} feature(s) matched no region -> ${OTHER}.ndjson`)
  }
  console.error(`region-tag: ${JSON.stringify(summary)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(`region-tag: ${err.message}`)
    process.exit(1)
  })
}

export { envelope, pointInGeometry, regionFor, loadRegions, run, parseArgs }
