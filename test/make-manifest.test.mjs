import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest } from '../bin/make-manifest.mjs'

// Disk-backed scratch under the gitignored .scratch/ dir (the box's /tmp is tmpfs).
const WORK = join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch')
mkdirSync(WORK, { recursive: true })

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(WORK, 'manifest-'))
  dirs.push(dir)
  const fgb = join(dir, 'caribbean.fgb')
  const bytes = Buffer.from('FGB-FIXTURE-BYTES')
  writeFileSync(fgb, bytes)
  const index = {
    generatedFrom: 'Navigator_2026_05.zip',
    exclusions: { categoryId9: 538, highSeas: 704, oversizeNoHardBan: 612 },
    regions: [
      {
        region: 'caribbean',
        assets: [
          {
            name: 'caribbean.fgb',
            path: fgb,
            bbox: [-100, 5, -55, 30],
            featureCount: 1234
          }
        ]
      }
    ]
  }
  const indexPath = join(dir, 'index.json')
  writeFileSync(indexPath, JSON.stringify(index))
  return {
    dir,
    indexPath,
    expectedSha: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  }
}

describe('buildManifest', () => {
  it('hashes and sizes each asset and carries bbox + featureCount through', () => {
    const f = fixture()
    const m = buildManifest({
      index: f.indexPath,
      version: 'v2026.05',
      datasetDate: '2026-05-28',
      downloadDate: '2026-06-01'
    })
    const asset = m.regions[0].assets[0]
    expect(asset.sha256).toBe(f.expectedSha)
    expect(asset.size).toBe(f.size)
    expect(asset.bbox).toEqual([-100, 5, -55, 30])
    expect(asset.featureCount).toBe(1234)
  })

  it('emits CC BY 4.0, three citations, and the locked disclaimer', () => {
    const f = fixture()
    const m = buildManifest({
      index: f.indexPath,
      version: 'v2026.05',
      datasetDate: '2026-05-28',
      downloadDate: '2026-06-01'
    })
    expect(m.license).toBe('CC BY 4.0')
    expect(m.citations).toHaveLength(3)
    expect(m.citations[0]).toContain('doi.org/10.1038/s41597-025-05535-2')
    expect(m.citations[2]).toContain('navigatormap.org/data-request')
    expect(m.disclaimer).toContain('NOT a legal or compliance document')
    expect(m.attribution).toContain('ProtectedSeas Navigator (CC BY 4.0)')
  })

  it('threads the dataset/download dates into the citation parentheticals', () => {
    const f = fixture()
    const m = buildManifest({
      index: f.indexPath,
      version: 'v2026.05',
      datasetDate: '2026-05-28',
      downloadDate: '2026-06-01'
    })
    expect(m.citations[1]).toContain('(last visited 2026-05-28)')
    expect(m.citations[2]).toContain('(downloaded 2026-06-01)')
  })

  it('passes the exclusion tallies through unchanged', () => {
    const f = fixture()
    const m = buildManifest({
      index: f.indexPath,
      version: 'v2026.05',
      datasetDate: '2026-05-28',
      downloadDate: '2026-06-01'
    })
    expect(m.exclusions).toEqual({ categoryId9: 538, highSeas: 704, oversizeNoHardBan: 612 })
  })
})
