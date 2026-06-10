import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { isExcludedPartition } from '../bin/lib/partition.mjs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const NORMALIZE = join(__dirname, '..', 'bin', 'normalize.mjs')
const FIXTURE = join(__dirname, 'fixtures', 'sample.geojson')
// Disk-backed scratch (never /tmp — tmpfs on the dev box), gitignored.
const SCRATCH = join(__dirname, '..', '.scratch', 'partition-test')

beforeAll(() => fs.mkdirSync(SCRATCH, { recursive: true }))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

describe('isExcludedPartition', () => {
  const tokens = ['HighSeas']

  it('matches the canonical short form', () => {
    expect(isExcludedPartition('HighSeas', tokens)).toBe(true)
  })

  it('REGRESSION: matches the raw member basename the workflows pass', () => {
    // Exact-equality matching meant the HighSeas exclusion NEVER fired in
    // CI/local builds (published v2026.05 tally: partition drops = 0).
    expect(isExcludedPartition('Navigator_AllSites_HighSeas_052826', tokens)).toBe(true)
  })

  it('does not match other partitions or incidental substrings', () => {
    expect(isExcludedPartition('Navigator_AllSites_GlobalEEZs_LFP1_052826', tokens)).toBe(false)
    expect(isExcludedPartition('LFP1', tokens)).toBe(false)
    expect(isExcludedPartition('NotHighSeasReally', tokens)).toBe(false)
    expect(isExcludedPartition('updates', tokens)).toBe(false)
    expect(isExcludedPartition('', tokens)).toBe(false)
  })
})

describe('normalize drops an excluded partition under its member basename', () => {
  it('records the partition drop and emits nothing', async () => {
    const out = {
      full: join(SCRATCH, 'hs.full.ndjson'),
      display: join(SCRATCH, 'hs.display.ndjson'),
      exclusions: join(SCRATCH, 'hs.exclusions.json')
    }
    await execFileAsync('node', [
      NORMALIZE,
      '--input',
      FIXTURE,
      '--partition',
      'Navigator_AllSites_HighSeas_052826',
      '--out-full',
      out.full,
      '--out-display',
      out.display,
      '--exclusions',
      out.exclusions
    ])
    const exclusions = JSON.parse(fs.readFileSync(out.exclusions, 'utf8'))
    expect(exclusions.excludedPartition).toBe(true)
    expect(exclusions.drops.partition).toBe(1)
    expect(fs.readFileSync(out.full, 'utf8')).toBe('')
  })
})
