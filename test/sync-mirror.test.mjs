import { describe, it, expect } from 'vitest'
import { rewriteAction, normalizeGeometryUnavailable, partitionAdded } from '../bin/sync-mirror.mjs'

const feature = (id, geometry = { type: 'Polygon', coordinates: [[[0, 0]]] }) => ({
  type: 'Feature',
  properties: { SITE_ID: id, site_name: `old ${id}` },
  geometry
})

const fresh = (id, geometry) => ({
  type: 'Feature',
  properties: { SITE_ID: id, site_name: `new ${id}` },
  geometry: geometry === undefined ? { type: 'MultiPolygon', coordinates: [[[[1, 1]]]] } : geometry
})

describe('rewriteAction (one mirror line during a sync rewrite)', () => {
  it('keeps untouched sites verbatim', () => {
    const consumed = new Set()
    const res = rewriteAction(feature('A'), new Map(), new Set(), consumed)
    expect(res).toEqual({ action: 'keep' })
    expect(consumed.size).toBe(0)
  })

  it('drops removed sites', () => {
    const res = rewriteAction(feature('A'), new Map(), new Set(['A']), new Set())
    expect(res).toEqual({ action: 'drop' })
  })

  it('replaces a refreshed site with the API record and marks it consumed', () => {
    const consumed = new Set()
    const refreshed = new Map([['A', fresh('A')]])
    const res = rewriteAction(feature('A'), refreshed, new Set(), consumed)
    expect(res.action).toBe('update')
    expect(res.feature.properties.site_name).toBe('new A')
    expect(res.feature.geometry.type).toBe('MultiPolygon')
    expect(consumed.has('A')).toBe(true)
  })

  it('keeps the OLD geometry when the API withheld the boundary', () => {
    // MarViva/WDPA/CBD CHM sources: attributes refresh, geometry survives.
    const refreshed = new Map([['A', fresh('A', null)]])
    const res = rewriteAction(feature('A'), refreshed, new Set(), new Set())
    expect(res.action).toBe('update')
    expect(res.feature.properties.site_name).toBe('new A')
    expect(res.feature.geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0]]] })
  })

  it('removal wins over refresh for the same id', () => {
    const refreshed = new Map([['A', fresh('A')]])
    const res = rewriteAction(feature('A'), refreshed, new Set(['A']), new Set())
    expect(res.action).toBe('drop')
  })

  it('keeps records it cannot identify', () => {
    const res = rewriteAction(
      { type: 'Feature', properties: {}, geometry: null },
      new Map([['A', fresh('A')]]),
      new Set(['B']),
      new Set()
    )
    expect(res).toEqual({ action: 'keep' })
  })
})

describe('withheld-boundary bookkeeping (geometryUnavailable)', () => {
  const api = new Map([
    ['A', { v: [1, 0], u: null }],
    ['B', { v: [2, 1], u: null }],
    ['GONE', { v: [1, 0], u: null }]
  ])

  it('migrates a legacy id array by adopting the current sweep versions', () => {
    const out = normalizeGeometryUnavailable(['A', 'B', 'VANISHED'], api)
    expect(out).toEqual({ A: { v: [1, 0] }, B: { v: [2, 1] } })
  })

  it('passes a versioned map through untouched and tolerates absence', () => {
    const map = { A: { v: [1, 0] } }
    expect(normalizeGeometryUnavailable(map, api)).toBe(map)
    expect(normalizeGeometryUnavailable(undefined, api)).toEqual({})
  })

  it('skips version-unchanged withheld sites and fetches the rest', () => {
    // A unchanged -> skip; B bumped since we last saw it -> retry; C unknown -> fetch
    const unavailable = { A: { v: [1, 0] }, B: { v: [2, 0] } }
    const { fetch, skipped } = partitionAdded(['A', 'B', 'C'], api, unavailable)
    expect(fetch).toEqual(['B', 'C'])
    expect(skipped).toEqual({ A: { v: [1, 0] } })
  })
})
