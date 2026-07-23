import { describe, it, expect } from 'vitest'
import {
  sweepIndex,
  changedSinceIds,
  changedSinceRows,
  isRemovedRow,
  assertInactiveFlagHonored,
  deriveDelta,
  patchIndex,
  assertSaneDelta,
  diffIndex,
  assertSaneSweep,
  maxLastUpdate
} from '../bin/sweep.mjs'
import { HIGH_SEAS_COUNTRY } from '../bin/lib/partition.mjs'

const site = (id, major, minor, lastUpdate) => ({
  site_id: id,
  site_major_version: String(major),
  site_minor_version: String(minor),
  last_update: lastUpdate ?? null
})

/** A sites_updated active/removed row (carries a status field + country). */
const row = (id, { status = 'active', country = 'Fiji', v = [1, 0], u = null } = {}) => ({
  site_id: id,
  status,
  country,
  site_major_version: String(v[0]),
  site_minor_version: String(v[1]),
  last_update: u
})

/** A getJson that serves the given pages in order. */
const pager = (pages, urls) => async (url) => {
  if (urls) urls.push(url)
  return pages.shift() ?? { sites: [] }
}

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

  it('reads ps_id and prefers it over the deprecated site_id duplicate', async () => {
    const getJson = async () => ({
      sites: [
        { ...site('OLD', 1, 0), ps_id: undefined }, // legacy row: only site_id present
        { ...site('WRONG', 2, 0), ps_id: 'NEW' } // transition row: ps_id wins over site_id
      ]
    })
    const index = await sweepIndex(getJson, { limit: 10 })
    expect([...index.keys()].sort()).toEqual(['NEW', 'OLD'])
  })
})

describe('changedSinceIds (the same-version-correction signal)', () => {
  it('collects updated ids across pages, passing changed_since through', async () => {
    const pages = [{ sites: [site('A', 1, 0), site('B', 2, 0)] }, { sites: [site('C', 1, 0)] }]
    const urls = []
    const getJson = async (url) => {
      urls.push(url)
      return pages.shift()
    }
    const ids = await changedSinceIds(getJson, '2026-06-11', { limit: 2 })
    expect([...ids].sort()).toEqual(['A', 'B', 'C'])
    expect(urls[0]).toContain('type=sites_updated')
    expect(urls[0]).toContain('changed_since=2026-06-11')
    expect(urls[1]).toContain('page=2')
  })

  it('excludes high-seas sites (never mirrored)', async () => {
    const getJson = async () => ({
      sites: [
        { ...site('A', 1, 0), country: 'Fiji' },
        { ...site('HS', 1, 0), country: HIGH_SEAS_COUNTRY }
      ]
    })
    const ids = await changedSinceIds(getJson, '2026-06-11', { limit: 10 })
    expect([...ids]).toEqual(['A'])
  })

  it('returns an empty set when nothing changed', async () => {
    const ids = await changedSinceIds(async () => ({ sites: [] }), '2026-06-11')
    expect(ids.size).toBe(0)
  })

  it('reads ps_id and prefers it over the deprecated site_id duplicate', async () => {
    const getJson = async () => ({
      sites: [
        { ...site('OLD', 1, 0), country: 'Fiji', ps_id: undefined },
        { ...site('WRONG', 1, 0), country: 'Fiji', ps_id: 'NEW' }
      ]
    })
    const ids = await changedSinceIds(getJson, '2026-06-11', { limit: 10 })
    expect([...ids].sort()).toEqual(['NEW', 'OLD'])
  })

  it('throws on non-terminating pagination', async () => {
    const getJson = async () => ({ sites: [site('A', 1, 0)] })
    await expect(changedSinceIds(getJson, '2026-06-11', { limit: 1, maxPages: 3 })).rejects.toThrow(
      'terminate'
    )
  })
})

describe('isRemovedRow / assertInactiveFlagHonored', () => {
  it('detects removed status case-insensitively', () => {
    expect(isRemovedRow({ status: 'removed' })).toBe(true)
    expect(isRemovedRow({ status: 'Removed' })).toBe(true)
    expect(isRemovedRow({ status: 'active' })).toBe(false)
    expect(isRemovedRow({})).toBe(false)
    expect(isRemovedRow(null)).toBe(false)
  })

  it('flag gate: empty window ok, rows-without-status throws, rows-with-status ok', () => {
    expect(() => assertInactiveFlagHonored(0, false)).not.toThrow()
    expect(() => assertInactiveFlagHonored(5, false)).toThrow('include_inactive')
    expect(() => assertInactiveFlagHonored(5, true)).not.toThrow()
  })
})

describe('changedSinceRows (incremental window classification)', () => {
  it('passes include_inactive + sort + changed_since and pages to the end', async () => {
    const urls = []
    const getJson = pager([{ sites: [row('A'), row('B')] }, { sites: [row('C')] }], urls)
    const res = await changedSinceRows(getJson, '2026-06-22', { limit: 2 })
    expect([...res.active.keys()].sort()).toEqual(['A', 'B', 'C'])
    expect(urls[0]).toContain('type=sites_updated')
    expect(urls[0]).toContain('include_inactive=true')
    expect(urls[0]).toContain('changed_since=2026-06-22')
    expect(urls[0]).toContain('sort=NAME_ASC')
    expect(urls[1]).toContain('page=2')
  })

  it('splits active / removed / reclassified-high-seas; counts reportedRows', async () => {
    const getJson = pager([
      {
        sites: [
          row('A', { status: 'active', country: 'Fiji' }),
          row('HS', { status: 'active', country: HIGH_SEAS_COUNTRY }),
          row('DEL', { status: 'removed', country: '' }), // removed rows often have empty country
          row('DELHS', { status: 'removed', country: HIGH_SEAS_COUNTRY })
        ]
      }
    ])
    const res = await changedSinceRows(getJson, '2026-06-22', { limit: 500 })
    expect([...res.active.keys()]).toEqual(['A'])
    expect(res.active.get('A').hs).toBe(false)
    expect([...res.reclassifiedHs]).toEqual(['HS'])
    expect([...res.removed].sort()).toEqual(['DEL', 'DELHS'])
    expect(res.reportedRows).toBe(4)
  })

  it('reads ps_id and prefers it over the deprecated site_id duplicate', async () => {
    const getJson = pager([
      {
        sites: [
          { ...row('OLD'), ps_id: undefined }, // legacy row: only site_id
          { ...row('WRONG'), ps_id: 'NEW' } // transition row: ps_id wins
        ]
      }
    ])
    const res = await changedSinceRows(getJson, '2026-06-22', { limit: 500 })
    expect([...res.active.keys()].sort()).toEqual(['NEW', 'OLD'])
  })

  it('throws when a non-empty window carries no status field (flag regression)', async () => {
    const noStatus = {
      site_id: 'A',
      country: 'Fiji',
      site_major_version: '1',
      site_minor_version: '0'
    }
    await expect(changedSinceRows(pager([{ sites: [noStatus] }]), '2026-06-22')).rejects.toThrow(
      'include_inactive'
    )
  })

  it('empty window returns empty sets without throwing', async () => {
    const res = await changedSinceRows(pager([{ sites: [] }]), '2026-06-22')
    expect(res.active.size).toBe(0)
    expect(res.removed.size).toBe(0)
    expect(res.reportedRows).toBe(0)
  })

  it('throws on non-terminating pagination', async () => {
    const getJson = async () => ({ sites: [row('A')] })
    await expect(
      changedSinceRows(getJson, '2026-06-22', { limit: 1, maxPages: 3 })
    ).rejects.toThrow('terminate')
  })
})

describe('deriveDelta (the heart — index ∪ geometryUnavailable)', () => {
  const idx = { KNOWN: { v: [1, 0], u: '2026-01-01' } }
  const parked = { PARKED: { v: [2, 0] } }

  it('classifies active rows: new->added, indexed->changed, parked->forceFetchParked', () => {
    const active = new Map([
      ['NEW', { v: [1, 0] }],
      ['KNOWN', { v: [1, 0] }],
      ['PARKED', { v: [2, 0] }]
    ])
    const d = deriveDelta(idx, parked, { active, removed: new Set(), reclassifiedHs: new Set() })
    expect(d.added).toEqual(['NEW'])
    expect(d.changed).toEqual(['KNOWN'])
    expect(d.forceFetchParked).toEqual(['PARKED'])
  })

  it('a BYTE-IDENTICAL indexed row is still changed (no version/date skip)', () => {
    // last_update is day-granular; a same-day double-correction must NOT be skipped.
    const active = new Map([['KNOWN', { v: [1, 0], u: '2026-01-01' }]])
    const d = deriveDelta(idx, {}, { active, removed: new Set(), reclassifiedHs: new Set() })
    expect(d.changed).toEqual(['KNOWN'])
  })

  it('removes only mirrored ids; cleans both stores; ignores unmirrored removals', () => {
    const removed = new Set(['KNOWN', 'PARKED', 'NEVER_SEEN'])
    const d = deriveDelta(idx, parked, { active: new Map(), removed, reclassifiedHs: new Set() })
    expect(d.removed.sort()).toEqual(['KNOWN', 'PARKED'])
  })

  it('active wins over removed for the same id, regardless of order', () => {
    const active = new Map([['KNOWN', { v: [1, 1] }]])
    const removed = new Set(['KNOWN'])
    const d = deriveDelta(idx, {}, { active, removed, reclassifiedHs: new Set() })
    expect(d.changed).toEqual(['KNOWN'])
    expect(d.removed).toEqual([])
  })

  it('a mirrored site reclassified to high-seas is removed; an unmirrored one is a no-op', () => {
    const reclassifiedHs = new Set(['KNOWN', 'BRAND_NEW_HS'])
    const d = deriveDelta(idx, {}, { active: new Map(), removed: new Set(), reclassifiedHs })
    expect(d.removed).toEqual(['KNOWN'])
    expect(d.added).toEqual([])
  })
})

describe('patchIndex (carry forward + patch both stores)', () => {
  const entryOfId = (id) => ({ A: { v: [1, 0], u: '2026-02-02' }, B: { v: [3, 0], u: null } })[id]

  it('removes ids from BOTH stores and preserves untouched baseline verbatim', () => {
    const oldIndex = { A: { v: [1, 0], u: 'x' }, KEEP: { v: [9, 9], u: 'y' } }
    const oldParked = { A: { v: [1, 0] }, P: { v: [5, 0] } }
    const { index, geometryUnavailable } = patchIndex(oldIndex, oldParked, {
      removedIds: new Set(['A']),
      refreshed: new Map(),
      consumed: new Set(),
      entryOfId
    })
    expect(index).toEqual({ KEEP: { v: [9, 9], u: 'y' } })
    expect(geometryUnavailable).toEqual({ P: { v: [5, 0] } })
  })

  it('refreshed with geometry -> indexed, dropped from parked', () => {
    const { index, geometryUnavailable } = patchIndex(
      {},
      { A: { v: [0, 0] } },
      {
        removedIds: new Set(),
        refreshed: new Map([['A', { geometry: { type: 'Polygon' } }]]),
        consumed: new Set(),
        entryOfId
      }
    )
    expect(index.A).toEqual({ v: [1, 0], u: '2026-02-02' })
    expect(geometryUnavailable.A).toBeUndefined()
  })

  it('refreshed null geometry but consumed -> stays indexed (kept old geometry)', () => {
    const { index, geometryUnavailable } = patchIndex(
      {},
      {},
      {
        removedIds: new Set(),
        refreshed: new Map([['A', { geometry: null }]]),
        consumed: new Set(['A']),
        entryOfId
      }
    )
    expect(index.A).toEqual({ v: [1, 0], u: '2026-02-02' })
    expect(geometryUnavailable.A).toBeUndefined()
  })

  it('refreshed null geometry, not consumed -> parked, absent from index', () => {
    const { index, geometryUnavailable } = patchIndex(
      {},
      {},
      {
        removedIds: new Set(),
        refreshed: new Map([['B', { geometry: null }]]),
        consumed: new Set(),
        entryOfId
      }
    )
    expect(index.B).toBeUndefined()
    expect(geometryUnavailable.B).toEqual({ v: [3, 0] })
  })

  it('does not mutate its inputs', () => {
    const oldIndex = { A: { v: [1, 0] } }
    const oldParked = { P: { v: [2, 0] } }
    patchIndex(oldIndex, oldParked, {
      removedIds: new Set(['A']),
      refreshed: new Map(),
      consumed: new Set(),
      entryOfId
    })
    expect(oldIndex).toEqual({ A: { v: [1, 0] } })
    expect(oldParked).toEqual({ P: { v: [2, 0] } })
  })
})

describe('assertSaneDelta', () => {
  it('caps removals on the absolute floor', () => {
    expect(() => assertSaneDelta(28000, { added: 0, changed: 0, removed: 250 })).toThrow('refusing')
  })

  it('caps removals on the ratio for a small mirror', () => {
    // 100 * 0.02 = 2 -> removing 10 trips it
    expect(() => assertSaneDelta(100, { added: 0, changed: 0, removed: 10 })).toThrow('refusing')
  })

  it('trips the total-delta tripwire (changed_since parse failure replaying history)', () => {
    expect(() => assertSaneDelta(28000, { added: 20000, changed: 0, removed: 0 })).toThrow(
      'implausible'
    )
  })

  it('does NOT block a large add/change batch with zero removals', () => {
    expect(() => assertSaneDelta(28000, { added: 5000, changed: 0, removed: 0 })).not.toThrow()
  })

  it('accepts a normal small delta and no-ops on an empty mirror', () => {
    expect(() => assertSaneDelta(28000, { added: 30, changed: 5, removed: 2 })).not.toThrow()
    expect(() => assertSaneDelta(0, { added: 5, changed: 0, removed: 0 })).not.toThrow()
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

  it('removes a mirrored site that upstream reclassified as high-seas', () => {
    const api = new Map([['HS1', { v: [2, 0], u: null, hs: true }]])
    const diff = diffIndex({ HS1: { v: [1, 0], u: null } }, api)
    expect(diff.removed).toEqual(['HS1'])
    expect(diff.changed).toEqual([])
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
