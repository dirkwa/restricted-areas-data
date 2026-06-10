#!/usr/bin/env node
/**
 * merge-exclusions: sum the per-partition exclusions.json tallies emitted by
 * normalize into one object for the manifest. Each input is NESTED, not flat:
 *   { partition, drops: { categoryId, areaWithoutHardBan, partition },
 *     counts: { featuresIn, kept, componentsFull, componentsDisplay } }
 * so we deep-sum the numeric sub-keys of drops/counts (a flat top-level sum
 * would concatenate the partition string and stringify the nested objects),
 * and collect the partition names into a list. Prints the merged object to
 * stdout.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Add only finite numbers; ignore strings/objects/missing keys so a
// whole-partition-excluded file (which may carry a subset of keys or extra
// flags like excludedPartition) sums whatever numeric tallies it does have.
function addNumeric(target, source) {
  if (!source || typeof source !== 'object') return
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    target[key] = (target[key] ?? 0) + value
  }
}

function mergeExclusions(paths) {
  const drops = {}
  const counts = {}
  const partitions = []
  for (const path of paths) {
    const part = JSON.parse(readFileSync(path, 'utf8'))
    addNumeric(drops, part.drops)
    addNumeric(counts, part.counts)
    if (typeof part.partition === 'string') partitions.push(part.partition)
  }
  return { drops, counts, partitions }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) throw new Error('usage: merge-exclusions <exclusions.json...>')
  process.stdout.write(JSON.stringify(mergeExclusions(paths), null, 2) + '\n')
}

export { mergeExclusions }
