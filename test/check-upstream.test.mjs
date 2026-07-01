import { describe, expect, it } from 'vitest'
import { isNewer, parseUpstreamDate, normalizeDate } from '../bin/check-upstream.mjs'

describe('normalizeDate', () => {
  it('passes through a valid ISO date', () => {
    expect(normalizeDate('2026-06-23')).toBe('2026-06-23')
  })

  it('converts a 6-digit MMDDYY (ArcGIS layer name) to ISO', () => {
    expect(normalizeDate('042426')).toBe('2026-04-24')
    expect(normalizeDate('010925')).toBe('2025-01-09')
  })

  it('rejects impossible or unrecognizable values', () => {
    expect(normalizeDate('2026-13-01')).toBe(null) // month 13
    expect(normalizeDate('2026-02-30')).toBe(null) // Feb 30
    expect(normalizeDate('139926')).toBe(null) // MM=13
    expect(normalizeDate('not-a-date')).toBe(null)
    expect(normalizeDate('')).toBe(null)
    expect(normalizeDate(null)).toBe(null)
    expect(normalizeDate(20260623)).toBe(null) // not a string
  })
})

describe('parseUpstreamDate', () => {
  it('reads the dataset date from the ArcGIS FeatureServer layer name', () => {
    const html =
      '<a href="https://services9.arcgis.com/abc/arcgis/rest/services/Navigator_AllSites_042426_attributes/FeatureServer">layer</a>'
    expect(parseUpstreamDate(html)).toBe('2026-04-24')
  })

  it('falls back to the "Last update: MM-DD-YYYY" text', () => {
    expect(parseUpstreamDate('<td>Last update: 04-24-2026</td>')).toBe('2026-04-24')
  })

  it('takes the newest across both signals', () => {
    const html = 'Navigator_AllSites_010925_attributes ... <td>Last update: 04-24-2026</td>'
    expect(parseUpstreamDate(html)).toBe('2026-04-24')
  })

  it('ignores an unrelated bare ISO string (no false positive from edit timestamps)', () => {
    // The page's own WordPress edit date must NOT be mistaken for a dataset date.
    expect(parseUpstreamDate('<meta content="2026-05-19T12:00:00">')).toBe(null)
  })

  it('returns null when the page has no recognizable date', () => {
    expect(parseUpstreamDate('<p>request access below</p>')).toBe(null)
    expect(parseUpstreamDate(null)).toBe(null)
  })
})

describe('isNewer', () => {
  it('is true when upstream is strictly later than published', () => {
    expect(isNewer('2026-05-28', '2026-04-01')).toBe(true)
  })

  it('is false when upstream equals or precedes published', () => {
    expect(isNewer('2026-05-28', '2026-05-28')).toBe(false)
    expect(isNewer('2026-03-01', '2026-05-28')).toBe(false)
  })

  it('treats a missing published date as always-newer', () => {
    expect(isNewer('2026-05-28', null)).toBe(true)
  })

  it('is false when upstream could not be parsed', () => {
    expect(isNewer(null, '2026-05-28')).toBe(false)
  })
})
