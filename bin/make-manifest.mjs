#!/usr/bin/env node
/**
 * make-manifest: build manifest.json describing the published per-region FGB
 * assets for a release. The plugin downloads this manifest to discover which
 * regional FlatGeobuf files exist, their sha256/size/bbox, and the locked
 * CC BY 4.0 attribution + disclaimer it must surface in the UI.
 *
 * The citation and disclaimer text is duplicated from the plugin's
 * attribution.ts on purpose: the two repos publish independently and this is the
 * canonical machine-readable copy the plugin reads back. Keep them in sync.
 *
 * Inputs are described by an index JSON (--index) produced by the build jobs:
 *   { region, assets: [{ name, path, bbox, featureCount }] }
 * make-manifest stats each asset path, hashes it, and emits the final manifest.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LICENSE = 'CC BY 4.0'

const DISCLAIMER =
  'This is summary data and may be incomplete, inaccurate, or out of date. It is NOT a legal or ' +
  'compliance document. Provided "as-is". Always verify against official sources before relying on ' +
  'it for navigation or compliance.'

const METHODOLOGY_CITATION =
  'Zetterlind, V. et al. (2025). Navigator - a global database of verified marine protected and ' +
  'managed area regulations and boundaries. Scientific Data, 12, 1212. ' +
  'https://doi.org/10.1038/s41597-025-05535-2'

function citations({ visited, downloaded } = {}) {
  const v = visited ? ` (last visited ${visited}).` : '.'
  const d = downloaded ? ` (downloaded ${downloaded}).` : '.'
  return [
    METHODOLOGY_CITATION,
    `The ProtectedSeas Navigator Map of Conservation Regulations, ProtectedSeas®, https://map.navigatormap.org${v}`,
    `Navigator Data Download, ProtectedSeas®. https://navigatormap.org/data-request${d}`
  ]
}

function attributionBlock(opts = {}) {
  return `Data: ProtectedSeas Navigator (CC BY 4.0). ${citations(opts).join(' ')} ${DISCLAIMER}`
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function parseArgs(argv) {
  const args = {
    index: null,
    version: null,
    datasetDate: null,
    downloadDate: null,
    generatedFrom: null
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--index') args.index = argv[++i]
    else if (a === '--version') args.version = argv[++i]
    else if (a === '--dataset-date') args.datasetDate = argv[++i]
    else if (a === '--download-date') args.downloadDate = argv[++i]
    else if (a === '--generated-from') args.generatedFrom = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  for (const k of ['index', 'version', 'datasetDate', 'downloadDate']) {
    if (!args[k]) throw new Error(`missing required --${k}`)
  }
  return args
}

/**
 * The index JSON describes the build outputs. `exclusions` is the per-reason
 * filtered-feature tally emitted by normalize/region-tag, carried through so the
 * manifest documents what was removed and why.
 */
function buildManifest(args) {
  const index = JSON.parse(readFileSync(args.index, 'utf8'))
  const opts = { visited: args.datasetDate, downloaded: args.downloadDate }

  const regions = index.regions.map((r) => ({
    region: r.region,
    assets: r.assets.map((asset) => ({
      name: asset.name,
      size: statSync(asset.path).size,
      sha256: sha256(asset.path),
      bbox: asset.bbox,
      featureCount: asset.featureCount
    }))
  }))

  return {
    version: args.version,
    datasetDate: args.datasetDate,
    downloadDate: args.downloadDate,
    generatedFrom: args.generatedFrom ?? index.generatedFrom ?? null,
    license: LICENSE,
    citations: citations(opts),
    disclaimer: DISCLAIMER,
    attribution: attributionBlock(opts),
    regions,
    exclusions: index.exclusions ?? {}
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  process.stdout.write(JSON.stringify(buildManifest(args), null, 2) + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

export { buildManifest, citations, attributionBlock, sha256 }
