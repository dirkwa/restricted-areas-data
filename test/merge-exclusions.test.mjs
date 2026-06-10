import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeExclusions } from '../bin/merge-exclusions.mjs'

// Disk-backed scratch under the gitignored .scratch/ dir (the box's /tmp is tmpfs).
const WORK = join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch')
mkdirSync(WORK, { recursive: true })

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Write each exclusion object to its own file and return the paths, mirroring
// how the workflow invokes merge-exclusions on work/*.exclusions.json.
function writeFixtures(objects) {
  const dir = mkdtempSync(join(WORK, 'merge-excl-'))
  dirs.push(dir)
  return objects.map((obj, i) => {
    const p = join(dir, `part-${i}.exclusions.json`)
    writeFileSync(p, JSON.stringify(obj))
    return p
  })
}

describe('mergeExclusions', () => {
  it('deep-sums drops/counts of the real nested shape into numbers', () => {
    const paths = writeFixtures([
      {
        partition: 'Navigator_AllSites_GlobalEEZs_LFP1_052826',
        drops: { categoryId: 370, areaWithoutHardBan: 54, partition: 0 },
        counts: { featuresIn: 11546, kept: 11122, componentsFull: 85729, componentsDisplay: 85729 }
      },
      {
        partition: 'Navigator_AllSites_GlobalEEZs_LFP2_052826',
        drops: { categoryId: 128, areaWithoutHardBan: 200, partition: 0 },
        counts: { featuresIn: 8383, kept: 8055, componentsFull: 37708, componentsDisplay: 37708 }
      },
      {
        partition: 'Navigator_AllSites_HighSeas_052826',
        drops: { categoryId: 0, areaWithoutHardBan: 162, partition: 0 },
        counts: { featuresIn: 704, kept: 542, componentsFull: 2573, componentsDisplay: 2573 }
      }
    ])

    const merged = mergeExclusions(paths)

    expect(merged.drops).toEqual({
      categoryId: 498,
      areaWithoutHardBan: 416,
      partition: 0
    })
    expect(merged.counts).toEqual({
      featuresIn: 20633,
      kept: 19719,
      componentsFull: 126010,
      componentsDisplay: 126010
    })
    expect(merged.partitions).toEqual([
      'Navigator_AllSites_GlobalEEZs_LFP1_052826',
      'Navigator_AllSites_GlobalEEZs_LFP2_052826',
      'Navigator_AllSites_HighSeas_052826'
    ])
  })

  it('keeps every tally numeric — never a string or [object Object]', () => {
    const paths = writeFixtures([
      {
        partition: 'A',
        drops: { categoryId: 1, areaWithoutHardBan: 2, partition: 0 },
        counts: { featuresIn: 3, kept: 3, componentsFull: 4, componentsDisplay: 4 }
      },
      {
        partition: 'B',
        drops: { categoryId: 5, areaWithoutHardBan: 6, partition: 0 },
        counts: { featuresIn: 7, kept: 7, componentsFull: 8, componentsDisplay: 8 }
      }
    ])

    const merged = mergeExclusions(paths)

    for (const v of [...Object.values(merged.drops), ...Object.values(merged.counts)]) {
      expect(typeof v).toBe('number')
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(JSON.stringify(merged)).not.toContain('[object Object]')
  })

  it('robustly sums a whole-partition-excluded file with a partial/extra shape', () => {
    const paths = writeFixtures([
      {
        partition: 'Navigator_AllSites_GlobalEEZs_LFP1_052826',
        drops: { categoryId: 10, areaWithoutHardBan: 4, partition: 0 },
        counts: { featuresIn: 100, kept: 86, componentsFull: 200, componentsDisplay: 200 }
      },
      {
        partition: 'Navigator_AllSites_HighSeas_052826',
        drops: { partition: 1 },
        counts: { featuresIn: 704, kept: 0 },
        excludedPartition: true
      }
    ])

    const merged = mergeExclusions(paths)

    // Only the keys actually present are summed; the non-numeric excludedPartition
    // flag never leaks into the tallies.
    expect(merged.drops).toEqual({ categoryId: 10, areaWithoutHardBan: 4, partition: 1 })
    expect(merged.counts).toEqual({
      featuresIn: 804,
      kept: 86,
      componentsFull: 200,
      componentsDisplay: 200
    })
    expect(merged).not.toHaveProperty('excludedPartition')
    expect(merged.partitions).toHaveLength(2)
  })
})
