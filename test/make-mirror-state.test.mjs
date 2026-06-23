import { describe, it, expect } from 'vitest'
import { buildState, foldFragments } from '../bin/make-mirror-state.mjs'

const args = {
  'seeded-from': 'staging-raw-052826',
  'dataset-date': '2026-05-28',
  'download-date': '2026-06-02'
}

describe('buildState (seed -> mirror-state anchors)', () => {
  it('anchors lastSweepDate to the dataset date and forces a first census', () => {
    const state = buildState(args, { A: { v: [1, 0], u: null } }, [], [])
    // A fresh seed is a complete census as of its dataset date -> that is the
    // correct changed_since anchor.
    expect(state.lastSweepDate).toBe('2026-05-28')
    // null census date -> the first post-seed sync runs an API census (the seed
    // is a bulk-download census, not an API one).
    expect(state.lastFullCensusDate).toBeNull()
    expect(state.siteCount).toBe(1)
    expect(state.geometryUnavailable).toEqual({})
    expect(state.datasetDate).toBe('2026-05-28')
    expect(state.downloadDate).toBe('2026-06-02')
  })

  it('rejects a dataset-date after the download-date', () => {
    expect(() => buildState({ ...args, 'dataset-date': '2026-06-10' }, {}, [], [])).toThrow(
      'after download-date'
    )
  })
})

describe('foldFragments', () => {
  it('merges per-partition site maps and tallies partitions (incl. skipped)', () => {
    const { sites, partitions } = foldFragments([
      { partition: 'LFP1', sites: { A: { v: [1, 0] }, B: { v: [2, 0] } } },
      { partition: 'HighSeas', skipped: true, sites: {} }
    ])
    expect(Object.keys(sites).sort()).toEqual(['A', 'B'])
    expect(partitions).toEqual([
      { partition: 'LFP1', skipped: false, sites: 2 },
      { partition: 'HighSeas', skipped: true, sites: 0 }
    ])
  })
})
