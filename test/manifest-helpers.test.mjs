import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeExclusions } from '../bin/merge-exclusions.mjs'
import { buildIndex } from '../bin/build-index.mjs'
import { regionMeta } from '../bin/region-meta.mjs'

const WORK = join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch')
mkdirSync(WORK, { recursive: true })

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch() {
  const dir = mkdtempSync(join(WORK, 'helpers-'))
  dirs.push(dir)
  return dir
}

describe('mergeExclusions', () => {
  it('sums per-reason counts across partition tallies', () => {
    const dir = scratch()
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeFileSync(a, JSON.stringify({ categoryId9: 200, highSeas: 704 }))
    writeFileSync(b, JSON.stringify({ categoryId9: 338, oversizeNoHardBan: 612 }))
    expect(mergeExclusions([a, b])).toEqual({
      categoryId9: 538,
      highSeas: 704,
      oversizeNoHardBan: 612
    })
  })
})

describe('regionMeta', () => {
  it('computes the union bbox and counts features from NDJSON', async () => {
    const dir = scratch()
    const ndjson = join(dir, 'caribbean.ndjson')
    writeFileSync(
      ndjson,
      [
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [-80, 18] }
        }),
        JSON.stringify({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [-60, 25] }
        }),
        ''
      ].join('\n')
    )
    const meta = await regionMeta({ region: 'caribbean', input: ndjson })
    expect(meta.region).toBe('caribbean')
    expect(meta.featureCount).toBe(2)
    expect(meta.bbox).toEqual([-80, 18, -60, 25])
  })
})

describe('buildIndex', () => {
  it('pairs full+display FGBs to one bbox/count per region from sidecars', () => {
    const dist = scratch()
    writeFileSync(join(dist, 'caribbean.fgb'), 'x')
    writeFileSync(join(dist, 'caribbean.display.fgb'), 'x')
    writeFileSync(
      join(dist, 'caribbean.meta.json'),
      JSON.stringify({ region: 'caribbean', bbox: [-100, 5, -55, 30], featureCount: 1234 })
    )
    const exclusions = join(dist, 'exclusions.json')
    writeFileSync(exclusions, JSON.stringify({ categoryId9: 538 }))

    const index = buildIndex({ dist, exclusions, generatedFrom: 'Navigator.zip' })
    expect(index.generatedFrom).toBe('Navigator.zip')
    expect(index.exclusions).toEqual({ categoryId9: 538 })
    expect(index.regions).toHaveLength(1)
    const assets = index.regions[0].assets
    expect(assets.map((a) => a.name)).toEqual(['caribbean.fgb', 'caribbean.display.fgb'])
    expect(assets.every((a) => a.featureCount === 1234)).toBe(true)
    expect(assets.every((a) => a.bbox[0] === -100)).toBe(true)
  })
})
