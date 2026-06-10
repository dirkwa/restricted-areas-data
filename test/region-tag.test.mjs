import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegions, regionFor } from '../bin/region-tag.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGIONS = loadRegions(join(HERE, '..', 'regions', 'regions.geojson'))

/** A tiny square polygon centred on [lon, lat]. */
function squareAt(lon, lat, half = 0.1) {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon - half, lat - half],
          [lon + half, lat - half],
          [lon + half, lat + half],
          [lon - half, lat + half],
          [lon - half, lat - half]
        ]
      ]
    }
  }
}

describe('regionFor', () => {
  it('tags a Fiji feature (east of the antimeridian) as sw-pacific', () => {
    expect(regionFor(squareAt(178, -17), REGIONS)).toBe('sw-pacific')
  })

  it('tags a feature just west of the antimeridian as sw-pacific', () => {
    expect(regionFor(squareAt(-179, -17), REGIONS)).toBe('sw-pacific')
  })

  it('tags a Caribbean feature as caribbean', () => {
    expect(regionFor(squareAt(-75, 18), REGIONS)).toBe('caribbean')
  })

  it('tags a Mediterranean feature as mediterranean, not ne-atlantic', () => {
    expect(regionFor(squareAt(10, 40), REGIONS)).toBe('mediterranean')
  })

  it('tags an Indian Ocean feature as indian-ocean', () => {
    expect(regionFor(squareAt(70, -10), REGIONS)).toBe('indian-ocean')
  })

  it('tags a Japan feature as nw-pacific (East Asia coverage)', () => {
    expect(regionFor(squareAt(140, 35), REGIONS)).toBe('nw-pacific')
  })

  it('tags a North Sea feature as north-europe, not ne-atlantic', () => {
    expect(regionFor(squareAt(3, 55), REGIONS)).toBe('north-europe')
  })

  it('tags a deep Southern Ocean feature as southern-ocean', () => {
    // Below lat -50: southern-ocean is authored first so it wins over every basin.
    expect(regionFor(squareAt(-20, -55), REGIONS)).toBe('southern-ocean')
  })

  it('routes a feature with no usable centroid to other', () => {
    // The tiling now covers the populated globe, so no real centroid lands in
    // `other`; this exercises the fallback path with a degenerate geometry whose
    // envelope (and centroid) is non-finite and therefore matches no polygon.
    const empty = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [] }
    }
    expect(regionFor(empty, REGIONS)).toBe('other')
  })

  it('routes an antimeridian-spanning component to sw-pacific regardless of centroid', () => {
    // A ring set with both far-east and far-west longitudes (a straddling
    // component). Its naive centroid (~0) would be wrong; spanning wins.
    const straddling = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [179, -15],
            [-179, -15],
            [-179, -16],
            [179, -16],
            [179, -15]
          ]
        ]
      }
    }
    expect(regionFor(straddling, REGIONS)).toBe('sw-pacific')
  })
})
