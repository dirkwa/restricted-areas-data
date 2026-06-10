import { describe, expect, it } from 'vitest'
import { isNewer, parseUpstreamDate } from '../bin/check-upstream.mjs'

describe('parseUpstreamDate', () => {
  it('picks the newest ISO date on the page', () => {
    const html = '<p>Updated 2026-01-15</p><span>dataset 2026-05-28</span><i>2025-12-01</i>'
    expect(parseUpstreamDate(html)).toBe('2026-05-28')
  })

  it('returns null when the page has no recognizable date', () => {
    expect(parseUpstreamDate('<p>request access below</p>')).toBe(null)
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
