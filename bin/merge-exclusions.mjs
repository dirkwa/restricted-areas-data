#!/usr/bin/env node
/**
 * merge-exclusions: sum the per-partition exclusions.json tallies emitted by
 * normalize into one object for the manifest. Each input is a flat
 * { reason: count } map; reasons are summed across partitions. Prints the
 * merged object to stdout.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function mergeExclusions(paths) {
  const total = {}
  for (const path of paths) {
    const part = JSON.parse(readFileSync(path, 'utf8'))
    for (const [reason, count] of Object.entries(part)) {
      total[reason] = (total[reason] ?? 0) + count
    }
  }
  return total
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) throw new Error('usage: merge-exclusions <exclusions.json...>')
  process.stdout.write(JSON.stringify(mergeExclusions(paths), null, 2) + '\n')
}

export { mergeExclusions }
