#!/usr/bin/env node
/**
 * build-index: assemble the make-manifest index from the build-region outputs.
 *
 * Each build-region matrix leg drops, next to its FGB pair, a sidecar
 * `<region>.meta.json` = { region, bbox, featureCount } (bbox/count are cheap to
 * compute from the region NDJSON it already streamed). build-index globs those
 * sidecars and emits the index make-manifest consumes:
 *   { generatedFrom, exclusions, regions: [{ region, assets: [...] }] }
 * Both the full and display FGB for a region share that region's bbox/count.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const args = { dist: null, exclusions: null, generatedFrom: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') args.dist = argv[++i]
    else if (a === '--exclusions') args.exclusions = argv[++i]
    else if (a === '--generated-from') args.generatedFrom = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.dist) throw new Error('missing required --dist')
  return args
}

function assetsForRegion(dist, meta) {
  const region = meta.region
  return [`${region}.fgb`, `${region}.display.fgb`]
    .filter((name) => readdirSync(dist).includes(name))
    .map((name) => ({
      name,
      path: join(dist, name),
      bbox: meta.bbox,
      featureCount: meta.featureCount
    }))
}

function buildIndex(args) {
  const metas = readdirSync(args.dist)
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => JSON.parse(readFileSync(join(args.dist, name), 'utf8')))
    .sort((a, b) => a.region.localeCompare(b.region))

  const regions = metas.map((meta) => ({
    region: meta.region,
    assets: assetsForRegion(args.dist, meta)
  }))

  const exclusions = args.exclusions ? JSON.parse(readFileSync(args.exclusions, 'utf8')) : {}
  return { generatedFrom: args.generatedFrom ?? null, exclusions, regions }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = buildIndex(parseArgs(process.argv.slice(2)))
  process.stdout.write(JSON.stringify(index, null, 2) + '\n')
}

export { buildIndex }
