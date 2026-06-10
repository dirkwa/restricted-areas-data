import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const NORMALIZE = join(__dirname, '..', 'bin', 'normalize.mjs')
const FIXTURE = join(__dirname, 'fixtures', 'sample.geojson')
// Disk-backed scratch (never /tmp — tmpfs on the dev box), gitignored.
const SCRATCH = join(__dirname, '..', '.scratch', 'normalize-ndjson-test')

beforeAll(() => fs.mkdirSync(SCRATCH, { recursive: true }))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

async function runNormalize(inputPath, format) {
  const out = {
    full: join(SCRATCH, `${format}.full.ndjson`),
    display: join(SCRATCH, `${format}.display.ndjson`),
    exclusions: join(SCRATCH, `${format}.exclusions.json`)
  }
  const args = [
    NORMALIZE,
    '--input',
    inputPath,
    '--partition',
    'LFP9',
    '--out-full',
    out.full,
    '--out-display',
    out.display,
    '--exclusions',
    out.exclusions
  ]
  if (format === 'ndjson') args.push('--format', 'ndjson')
  await execFileAsync('node', args)
  return {
    full: fs.readFileSync(out.full, 'utf8').trim().split('\n').filter(Boolean),
    exclusions: JSON.parse(fs.readFileSync(out.exclusions, 'utf8'))
  }
}

describe('normalize --format ndjson (mirror shard input)', () => {
  it('produces byte-identical output to FeatureCollection input', async () => {
    // Same features, two packagings: the bulk-download FeatureCollection and
    // the mirror's one-feature-per-line NDJSON.
    const fc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    const ndjsonPath = join(SCRATCH, 'input.ndjson')
    fs.writeFileSync(ndjsonPath, fc.features.map((f) => JSON.stringify(f)).join('\n') + '\n')

    const fromCollection = await runNormalize(FIXTURE, 'geojson')
    const fromNdjson = await runNormalize(ndjsonPath, 'ndjson')

    expect(fromNdjson.full).toEqual(fromCollection.full)
    expect(fromNdjson.exclusions.drops).toEqual(fromCollection.exclusions.drops)
    expect(fromNdjson.exclusions.counts).toEqual(fromCollection.exclusions.counts)
  })
})
