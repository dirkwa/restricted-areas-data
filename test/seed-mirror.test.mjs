import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { mirrorLine, indexEntry } from '../bin/seed-mirror.mjs'
import { foldFragments } from '../bin/make-mirror-state.mjs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = join(__dirname, '..', 'bin', 'seed-mirror.mjs')
const FIXTURE = join(__dirname, 'fixtures', 'sample.geojson')
// Disk-backed scratch (never /tmp — tmpfs on the dev box), gitignored.
const SCRATCH = join(__dirname, '..', '.scratch', 'seed-mirror-test')

beforeAll(() => fs.mkdirSync(SCRATCH, { recursive: true }))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

describe('mirrorLine / indexEntry', () => {
  it('serializes a feature verbatim, one line', () => {
    const f = { type: 'Feature', properties: { SITE_ID: 'X' }, geometry: null, extra: 'dropped' }
    const parsed = JSON.parse(mirrorLine(f))
    expect(parsed).toEqual({ type: 'Feature', properties: { SITE_ID: 'X' }, geometry: null })
    expect(mirrorLine(f)).not.toContain('\n')
  })

  it('builds a sweep-compatible index entry with numeric versions and u=null', () => {
    expect(indexEntry({ site_major_version: '2', site_minor_version: 1 })).toEqual({
      v: [2, 1],
      u: null
    })
    expect(indexEntry({})).toEqual({ v: [null, null], u: null })
  })
})

describe('seed-mirror CLI', () => {
  it('writes a gzipped NDJSON shard plus an index fragment', async () => {
    const out = join(SCRATCH, 'LFP9.ndjson.gz')
    const indexOut = join(SCRATCH, 'LFP9.index.json')
    await execFileAsync('node', [
      SEED,
      '--partition',
      'LFP9',
      '--input',
      FIXTURE,
      '--out',
      out,
      '--index-out',
      indexOut
    ])
    const lines = zlib
      .gunzipSync(fs.readFileSync(out))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const fixtureCount = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).features.length
    expect(lines.length).toBe(fixtureCount)
    expect(lines[0].type).toBe('Feature')
    const fragment = JSON.parse(fs.readFileSync(indexOut, 'utf8'))
    expect(fragment.partition).toBe('LFP9')
    expect(Object.keys(fragment.sites).length).toBe(fixtureCount)
  })

  it('skips excluded partitions without writing a shard', async () => {
    const out = join(SCRATCH, 'HighSeas.ndjson.gz')
    const indexOut = join(SCRATCH, 'HighSeas.index.json')
    await execFileAsync('node', [
      SEED,
      '--partition',
      'HighSeas',
      '--input',
      FIXTURE,
      '--out',
      out,
      '--index-out',
      indexOut
    ])
    expect(fs.existsSync(out)).toBe(false)
    const fragment = JSON.parse(fs.readFileSync(indexOut, 'utf8'))
    expect(fragment.skipped).toBe(true)
    expect(fragment.sites).toEqual({})
  })
})

describe('foldFragments', () => {
  it('merges fragment site maps and reports per-partition counts', () => {
    const { sites, partitions } = foldFragments([
      { partition: 'LFP1', sites: { A: { v: [1, 0], u: null } } },
      { partition: 'HighSeas', skipped: true, sites: {} },
      { partition: 'LFP2', sites: { B: { v: [2, 0], u: null } } }
    ])
    expect(Object.keys(sites).sort()).toEqual(['A', 'B'])
    expect(partitions).toEqual([
      { partition: 'LFP1', skipped: false, sites: 1 },
      { partition: 'HighSeas', skipped: true, sites: 0 },
      { partition: 'LFP2', skipped: false, sites: 1 }
    ])
  })
})
