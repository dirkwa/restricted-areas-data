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

  it('routes a centroid matching no region to other', () => {
    // Mid South Atlantic: outside every authored basin envelope.
    expect(regionFor(squareAt(-20, -40), REGIONS)).toBe('other')
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
