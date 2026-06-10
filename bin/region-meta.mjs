#!/usr/bin/env node
/**
 * region-meta: compute a region's bbox + featureCount from its NDJSON, for the
 * manifest. Emitted as a sidecar next to the region's FGB pair during the build
 * job; build-index folds it into the make-manifest index. Streams the NDJSON so
 * a multi-hundred-MB region file never lands in memory whole.
 */

import { bbox } from '@turf/bbox'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const args = { region: null, input: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--region') args.region = argv[++i]
    else if (a === '--input') args.input = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  for (const k of ['region', 'input']) {
    if (!args[k]) throw new Error(`missing required --${k}`)
  }
  return args
}

async function regionMeta({ region, input }) {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  let featureCount = 0

  const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (line === '') continue
    featureCount++
    const [w, s, e, n] = bbox(JSON.parse(line))
    if (w < minLon) minLon = w
    if (s < minLat) minLat = s
    if (e > maxLon) maxLon = e
    if (n > maxLat) maxLat = n
  }

  const box = featureCount === 0 ? null : [minLon, minLat, maxLon, maxLat]
  return { region, bbox: box, featureCount }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await regionMeta(parseArgs(process.argv.slice(2)))
  process.stdout.write(JSON.stringify(out) + '\n')
}

export { regionMeta }
