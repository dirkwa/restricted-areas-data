import { describe, it, expect } from 'vitest'
import { sweepIndex, diffIndex, assertSaneSweep, maxLastUpdate } from '../bin/sweep.mjs'
import { HIGH_SEAS_COUNTRY } from '../bin/lib/partition.mjs'

const site = (id, major, minor, lastUpdate) => ({
  site_id: id,
  site_major_version: String(major),
  site_minor_version: String(minor),
  last_update: lastUpdate ?? null
})

describe('sweepIndex', () => {
  it('pages until a short page and indexes by SITE_ID with numeric versions', async () => {
    const pages = [
      { sites: [site('A', 1, 0, '2025-01-01'), site('B', 2, 3, null)] },
      { sites: [site('C', 1, 1, '2026-02-02')] }
    ]
    const urls = []
    const getJson = async (url) => {
      urls.push(url)
      return pages.shift()
    }
    const index = await sweepIndex(getJson, { limit: 2 })
    expect(index.size).toBe(3)
    expect(index.get('A')).toEqual({ v: [1, 0], u: '2025-01-01', hs: false })
    expect(index.get('B')).toEqual({ v: [2, 3], u: null, hs: false })
    expect(urls[0]).toContain('type=sites')
    expect(urls[0]).toContain('limit=2')
    expect(urls[1]).toContain('page=2')
  })

  it('throws instead of looping forever on broken pagination', async () => {
    const getJson = async () => ({ sites: [site('A', 1, 0)] })
    await expect(sweepIndex(getJson, { limit: 1, maxPages: 3 })).rejects.toThrow('terminate')
  })
})

describe('diffIndex', () => {
  const mirror = {
    A: { v: [1, 0], u: null },
    B: { v: [2, 3], u: null },
    C: { v: [1, 1], u: '2026-01-01' }
  }

  it('classifies added / changed / removed by version', () => {
    const api = new Map([
      ['A', { v: [1, 0], u: '2025-01-01' }], // same version -> unchanged
      ['B', { v: [3, 0], u: null }], // major bump -> changed
      ['D', { v: [1, 0], u: null }] // new -> added
      // C missing -> removed
    ])
    const diff = diffIndex(mirror, api)
    expect(diff.added).toEqual(['D'])
    expect(diff.changed).toEqual(['B'])
    expect(diff.removed).toEqual(['C'])
  })

  it('falls back to last_update when both sides know it (belt and braces)', () => {
    const api = new Map([['C', { v: [1, 1], u: '2026-03-01' }]])
    const diff = diffIndex({ C: mirror.C }, api)
    expect(diff.changed).toEqual(['C'])
  })

  it('does not flag a date-only difference when the mirror has no date (seed state)', () => {
    const api = new Map([['A', { v: [1, 0], u: '2026-03-01' }]])
    expect(diffIndex({ A: mirror.A }, api).changed).toEqual([])
  })

  it('a minor-version bump alone is a change', () => {
    const api = new Map([['B', { v: [2, 4], u: null }]])
    expect(diffIndex({ B: mirror.B }, api).changed).toEqual(['B'])
  })

  it('ignores high-seas catalog entries (the HighSeas partition exclusion, API side)', () => {
    // The catalog lists ~700 high-seas RFMO sites the mirror deliberately
    // omits; they must never surface as "added" (or be fetched weekly).
    const api = new Map([
      ['HS1', { v: [1, 0], u: null, hs: true }],
      ['D', { v: [1, 0], u: null, hs: false }]
    ])
    const diff = diffIndex({}, api)
    expect(diff.added).toEqual(['D'])
  })
})

describe('sweepIndex marks high-seas sites', () => {
  it('flags entries by the High Seas country value', async () => {
    const getJson = async () => ({
      sites: [
        { ...site('HS1', 1, 0), country: HIGH_SEAS_COUNTRY },
        { ...site('A', 1, 0), country: 'Fiji' }
      ]
    })
    const index = await sweepIndex(getJson, { limit: 10 })
    expect(index.get('HS1').hs).toBe(true)
    expect(index.get('A').hs).toBe(false)
  })
})

describe('assertSaneSweep', () => {
  it('rejects a half-empty catalog (API anomaly must not mass-delete)', () => {
    expect(() => assertSaneSweep(27000, 9000, 0)).toThrow('half-empty')
  })

  it('rejects removals above the safety ratio', () => {
    expect(() => assertSaneSweep(27000, 26000, 5000)).toThrow('refusing')
  })

  it('accepts a plausible sweep', () => {
    expect(() => assertSaneSweep(27000, 27100, 12)).not.toThrow()
  })

  it('accepts anything when the mirror is empty (bootstrap)', () => {
    expect(() => assertSaneSweep(0, 5, 0)).not.toThrow()
  })
})

describe('maxLastUpdate', () => {
  it('returns the latest known last_update, ignoring high-seas entries', () => {
    const api = new Map([
      ['A', { v: [1, 0], u: '2025-01-01' }],
      ['B', { v: [1, 0], u: '2026-04-30' }],
      ['C', { v: [1, 0], u: null }],
      ['HS', { v: [1, 0], u: '2026-12-31', hs: true }]
    ])
    expect(maxLastUpdate(api)).toBe('2026-04-30')
  })

  it('returns null when nothing carries a date', () => {
    expect(maxLastUpdate(new Map([['A', { v: [1, 0], u: null }]]))).toBeNull()
  })
})
