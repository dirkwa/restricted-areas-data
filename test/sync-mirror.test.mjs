import { describe, it, expect } from 'vitest'
import { rewriteAction } from '../bin/sync-mirror.mjs'

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
