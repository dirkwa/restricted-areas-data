import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  apiSiteToDownloadProps,
  apiGeometry,
  apiDetailToMirrorFeature
} from '../bin/lib/api-map.mjs'
import { normalizeProps } from '../bin/lib/decode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DETAIL = JSON.parse(
  fs.readFileSync(join(__dirname, 'fixtures', 'api', 'detail-AIISR33.json'), 'utf8')
)
const SEARCH = JSON.parse(
  fs.readFileSync(join(__dirname, 'fixtures', 'api', 'search-page1-limit3.json'), 'utf8')
)

describe('apiSiteToDownloadProps (golden: real /api/detail response)', () => {
  const props = apiSiteToDownloadProps(DETAIL)

  it('renames the five diverging fields to their download names', () => {
    expect(props.SITE_ID).toBe('AIISR33')
    expect(props.marine_area).toBe(51.50640992254116)
    expect(props.percent_marine).not.toBeUndefined()
    expect(props.site_location).toBe(0)
    expect(props.tribal).not.toBeUndefined()
    for (const apiName of [
      'ps_id',
      'total_marine_area',
      'percent_marine_area',
      'location_type',
      'tribal_exemptions'
    ]) {
      expect(props).not.toHaveProperty(apiName)
    }
  })

  it('coerces the string-typed numerics the API returns', () => {
    // The API serializes every number as a string; the download has numbers.
    expect(props.site_major_version).toBe(2)
    expect(props.site_minor_version).toBe(0)
    expect(props.lfp).toBe(0)
    expect(props.commercial_fishing).toBe(1)
    expect(props.anchoring).toBe(3)
    expect(props.total_area).toBeCloseTo(51.509491071502865)
  })

  it('never Number()-parses wdpa_id (composite ids like "555542441; 555637321")', () => {
    expect(props.wdpa_id).toBe('0')
    const composite = apiSiteToDownloadProps({ wdpa_id: '555542441; 555637321' })
    expect(composite.wdpa_id).toBe('555542441; 555637321')
  })

  it('drops API-only fields and null-fills download-only columns', () => {
    for (const apiOnly of ['ogc_fid', 'site_boundary', 'bounds', 'type', 'last_update']) {
      expect(props).not.toHaveProperty(apiOnly)
    }
    for (const downloadOnly of ['OBJECTID', 'other_helpful_links', 'Shape_Area']) {
      expect(props[downloadOnly]).toBeNull()
    }
  })

  it('accepts search-response sites too (site_id -> SITE_ID)', () => {
    const fromSearch = apiSiteToDownloadProps(SEARCH.sites[0])
    expect(fromSearch.SITE_ID).toBe(SEARCH.sites[0].site_id)
    expect(typeof fromSearch.site_major_version).toBe('number')
  })

  it('prefers ps_id over the deprecated site_id duplicate; neither raw key leaks', () => {
    // During the deprecation window both keys are returned; here they carry
    // DIFFERENT values so precedence is observable. The adapter must not depend
    // on their order in the API object, and the deprecated value must never win.
    // Assert BOTH key orders — a rename-map keyed by SITE_ID resolves order-last,
    // so only one order would catch it.
    for (const both of [
      apiSiteToDownloadProps({ ps_id: 'CANONICAL', site_id: 'DEPRECATED' }),
      apiSiteToDownloadProps({ site_id: 'DEPRECATED', ps_id: 'CANONICAL' })
    ]) {
      expect(both.SITE_ID).toBe('CANONICAL')
      expect(both).not.toHaveProperty('ps_id')
      expect(both).not.toHaveProperty('site_id')
    }

    // Legacy row with only site_id still resolves via the fallback.
    expect(apiSiteToDownloadProps({ site_id: 'LEGACY' }).SITE_ID).toBe('LEGACY')
  })

  it('decodes identically to the download record after adaptation', () => {
    // Verified once against the bulk download: this site decodes to exactly
    // these values from BOTH sources. Pins the adapter to that parity.
    const norm = normalizeProps(props)
    expect(norm.siteId).toBe('AIISR33')
    expect(norm.lfp).toBe(0)
    expect(norm.wdpaId).toBeNull()
    expect(norm.tribalExemption).toBe(false)
    expect(norm.restrictions.fishingCommercial).toBe('prohibited')
    expect(norm.restrictions.fishingRecreational).toBe('prohibited')
    expect(norm.restrictions.anchoring).toBe('unknown')
    expect(norm.restrictions.entry).toBe('unknown')
    expect(norm.siteVersion).toEqual({ major: 2, minor: 0 })
  })
})

describe('apiGeometry', () => {
  it('strips the constant Z coordinate from every vertex', () => {
    const geom = apiGeometry(DETAIL.site_boundary)
    expect(geom.type).toBe('MultiPolygon')
    const firstVertex = geom.coordinates[0][0][0]
    expect(firstVertex).toEqual([34.989667933, 33.007480255])
    const allVertices = geom.coordinates.flat(2)
    expect(allVertices.every((v) => v.length === 2)).toBe(true)
  })

  it('returns null for withheld boundaries (MarViva/WDPA/CBD CHM sources)', () => {
    expect(apiGeometry(null)).toBeNull()
    expect(apiGeometry(undefined)).toBeNull()
    expect(apiGeometry({})).toBeNull()
    expect(apiGeometry({ type: 'MultiPolygon', coordinates: [] })).toBeNull()
    expect(apiGeometry({ type: 'Point', coordinates: [1, 2] })).toBeNull()
  })
})

describe('apiDetailToMirrorFeature', () => {
  it('builds a download-schema Feature with 2D geometry', () => {
    const feature = apiDetailToMirrorFeature(DETAIL)
    expect(feature.type).toBe('Feature')
    expect(feature.properties.SITE_ID).toBe('AIISR33')
    expect(feature.geometry.type).toBe('MultiPolygon')
    expect(feature.properties).not.toHaveProperty('site_boundary')
  })

  it('signals a withheld boundary as geometry: null', () => {
    const withheld = { ...DETAIL, site_boundary: null }
    const feature = apiDetailToMirrorFeature(withheld)
    expect(feature.geometry).toBeNull()
    expect(feature.properties.SITE_ID).toBe('AIISR33')
  })
})
