import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  levelOf,
  moreRestrictive,
  coarseRestrictions,
  categoryIdOf,
  normalizeProps
} from '../bin/lib/decode.mjs'
import {
  processFeature,
  components,
  roundPolygon,
  marineAreaKm2,
  flattenForFgb,
  FGB_JSON_FIELDS
} from '../bin/normalize.mjs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'sample.geojson')
const NORMALIZE = join(__dirname, '..', 'bin', 'normalize.mjs')

/** Minimal raw feature with a single-ring square Polygon. */
function feature(properties, geometry) {
  return {
    type: 'Feature',
    properties,
    geometry: geometry ?? {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0]
        ]
      ]
    }
  }
}

describe('decode mirrors the plugin schema', () => {
  it('GOLDEN: levelOf(1) is prohibited, never truthy/allowed', () => {
    expect(levelOf(1)).toBe('prohibited')
    expect(levelOf(0)).toBe('allowed')
    expect(levelOf(2)).toBe('restricted')
    expect(levelOf(3)).toBe('unknown')
    expect(levelOf(null)).toBe('na')
    expect(levelOf(undefined)).toBe('na')
  })

  it('decodes string-encoded cells the same as numbers', () => {
    expect(levelOf('1')).toBe('prohibited')
    expect(levelOf('0')).toBe('allowed')
    expect(levelOf('')).toBe('na')
  })

  it('moreRestrictive keeps prohibited over restricted over allowed over unknown over na', () => {
    expect(moreRestrictive('restricted', 'prohibited')).toBe('prohibited')
    expect(moreRestrictive('allowed', 'restricted')).toBe('restricted')
    expect(moreRestrictive('unknown', 'allowed')).toBe('allowed')
    expect(moreRestrictive('na', 'unknown')).toBe('unknown')
    expect(moreRestrictive('na', 'na')).toBe('na')
  })

  it('categoryIdOf maps labels and falls back to unknown on drift', () => {
    expect(categoryIdOf('Jurisdictional Authority Area')).toBe(9)
    expect(categoryIdOf('Marine Protected Area')).toBe(1)
    expect(categoryIdOf('Some New Label')).toBe('unknown')
    expect(categoryIdOf(null)).toBe('unknown')
  })
})

describe('coarse coalescing (V1/V2 agreement)', () => {
  it('dredging coalesces dredging and dredging_dumping to the more restrictive', () => {
    // V1 row: dredging set, dredging_dumping null.
    expect(coarseRestrictions({ dredging: 1, dredging_dumping: null }).dredging).toBe('prohibited')
    // V2 row: dredging null, dredging_dumping set — same coarse answer.
    expect(coarseRestrictions({ dredging: null, dredging_dumping: 1 }).dredging).toBe('prohibited')
    // Both present: most restrictive wins.
    expect(coarseRestrictions({ dredging: 2, dredging_dumping: 1 }).dredging).toBe('prohibited')
  })

  it('fishingArtisanal folds artisanal + subsistence', () => {
    expect(
      coarseRestrictions({ artisanal_fishing: 0, subsistence_fishing: 1 }).fishingArtisanal
    ).toBe('prohibited')
    expect(
      coarseRestrictions({ artisanal_fishing: 2, subsistence_fishing: null }).fishingArtisanal
    ).toBe('restricted')
  })

  it('fishing rolls up over all 25 gear columns', () => {
    // A single prohibited gear column drives the whole rollup to prohibited.
    expect(coarseRestrictions({ longlining: 1 }).fishing).toBe('prohibited')
    // No coded fishing column -> na, not allowed.
    expect(coarseRestrictions({ entry: 0 }).fishing).toBe('na')
    // underwater_extraction_diving is EXTRACTIVE: it feeds fishing, not diving.
    expect(coarseRestrictions({ underwater_extraction_diving: 1 }).fishing).toBe('prohibited')
    expect(coarseRestrictions({ underwater_extraction_diving: 1 }).diving).toBe('na')
  })
})

describe('normalizeProps shape', () => {
  it('produces type-stable identity and special fields', () => {
    const n = normalizeProps({
      SITE_ID: 'X1',
      site_name: 'Cove',
      wdpa_id: 0,
      iucn_cat: 'Unassigned',
      tribal: 0,
      lfp: 3,
      category_name: 'Recreational Area'
    })
    expect(n.siteId).toBe('X1')
    expect(n.wdpaId).toBeNull() // 0 means absent
    expect(n.iucnCat).toBeNull() // 'Unassigned' means absent
    expect(n.tribalExemption).toBe(true) // tribal 0 -> exemption true (inverted)
    expect(n.lfp).toBe(3)
    expect(n.categoryId).toBe(5)
  })

  it('keeps composite wdpa_id verbatim and never Number()-parses', () => {
    expect(normalizeProps({ wdpa_id: '555542441; 555637321' }).wdpaId).toBe('555542441; 555637321')
    expect(normalizeProps({ wdpa_id: '102534_B' }).wdpaId).toBe('102534_B')
  })
})

describe('exclusion logic (LOCKED mapping.json.exclude)', () => {
  it('drops categoryId === 9 (jurisdictional)', () => {
    const r = processFeature(feature({ category_name: 'Jurisdictional Authority Area' }))
    expect(r.drop).toBe('categoryId')
  })

  it('drops a >50000 km2 feature with no hard ban', () => {
    const r = processFeature(
      feature({ category_name: 'Fisheries Management Area', marine_area: 60000, entry: 0 })
    )
    expect(r.drop).toBe('areaWithoutHardBan')
  })

  it('KEEPS a >50000 km2 feature when anchoring === 1 (hard ban)', () => {
    const r = processFeature(
      feature({ category_name: 'Vessel Restricted Area', marine_area: 60000, anchoring: 1 })
    )
    expect(r.drop).toBeUndefined()
    expect(r.full.length).toBeGreaterThan(0)
  })

  it('KEEPS a >50000 km2 feature when entry === 1 (hard ban)', () => {
    const r = processFeature(
      feature({ category_name: 'Fisheries Management Area', marine_area: 60000, entry: 1 })
    )
    expect(r.drop).toBeUndefined()
  })

  it('KEEPS a small inland-water feature (no marine_area cap hit)', () => {
    const r = processFeature(
      feature({ category_name: 'Water Quality/Human Health Area', marine_area: null, entry: 0 })
    )
    expect(r.drop).toBeUndefined()
    expect(r.full.length).toBe(1)
  })

  it('drops a planet-spanning overlay with marine_area=null (the IMO/WTO case)', () => {
    // bbox spans ~360deg lon — the km2 cap can't see it (marine_area null) but
    // the bbox-span cap must.
    const planet = {
      type: 'Polygon',
      coordinates: [
        [
          [-179, -85],
          [179, -85],
          [179, 85],
          [-179, 85],
          [-179, -85]
        ]
      ]
    }
    const r = processFeature(
      feature({ category_name: 'Other', marine_area: null, entry: 3 }, planet)
    )
    expect(r.drop).toBe('bboxSpanWithoutHardBan')
  })

  it('KEEPS a planet-spanning feature that carries a hard ban', () => {
    const planet = {
      type: 'Polygon',
      coordinates: [
        [
          [-179, -85],
          [179, -85],
          [179, 85],
          [-179, 85],
          [-179, -85]
        ]
      ]
    }
    const r = processFeature(feature({ category_name: 'Other', anchoring: 1 }, planet))
    expect(r.drop).toBeUndefined()
  })
})

describe('geometry explosion and display rounding', () => {
  it('explodes MultiPolygon into one component per polygon, each with its own bbox', () => {
    const multi = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [30, 30],
            [31, 30],
            [31, 31],
            [30, 31],
            [30, 30]
          ]
        ],
        [
          [
            [40, 40],
            [41, 40],
            [41, 41],
            [40, 41],
            [40, 40]
          ]
        ]
      ]
    }
    const r = processFeature(
      feature({ SITE_ID: 'M', category_name: 'Recreational Area', anchoring: 1 }, multi)
    )
    expect(r.full).toHaveLength(2)
    expect(r.full.map((f) => f.geometry.type)).toEqual(['Polygon', 'Polygon'])
    expect(r.full.map((f) => f._meta.componentIndex)).toEqual([0, 1])
    // Per-component bbox, never a feature-wide bbox spanning both squares.
    expect(r.full[0]._meta.bbox).toEqual([30, 30, 31, 31])
    expect(r.full[1]._meta.bbox).toEqual([40, 40, 41, 41])
  })

  it('components() returns [] for non-polygon geometry', () => {
    expect(components({ type: 'Point', coordinates: [0, 0] })).toEqual([])
    expect(components(null)).toEqual([])
  })

  it('display geometry rounds coords to 5 decimals; full keeps precision', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [-70.123456789, 41.987654321],
          [-70.0, 41.987654321],
          [-70.0, 41.0],
          [-70.123456789, 41.0],
          [-70.123456789, 41.987654321]
        ]
      ]
    }
    const r = processFeature(
      feature({ SITE_ID: 'P', category_name: 'Recreational Area', anchoring: 1 }, poly)
    )
    expect(r.full[0].geometry.coordinates[0][0]).toEqual([-70.123456789, 41.987654321])
    expect(r.display[0].geometry.coordinates[0][0]).toEqual([-70.12346, 41.98765])
  })

  it('marineAreaKm2 reads numbers and numeric strings, else null', () => {
    expect(marineAreaKm2({ marine_area: 12 })).toBe(12)
    expect(marineAreaKm2({ marine_area: '50' })).toBe(50)
    expect(marineAreaKm2({ marine_area: null })).toBeNull()
    expect(marineAreaKm2({})).toBeNull()
  })

  it('roundPolygon preserves ring closure', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [1.111111, 2.222222],
          [3, 2.222222],
          [3, 4],
          [1.111111, 4],
          [1.111111, 2.222222]
        ]
      ]
    }
    const rounded = roundPolygon(poly, 5)
    const ring = rounded.coordinates[0]
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })
})

describe('end-to-end normalize.mjs over a fixture file', () => {
  let dir
  let outFull
  let outDisplay
  let exclusions

  beforeAll(async () => {
    // Disk-backed scratch under the repo, not RAM-backed /tmp.
    const scratch = join(__dirname, '..', '.scratch')
    fs.mkdirSync(scratch, { recursive: true })
    dir = fs.mkdtempSync(join(scratch, 'ra-normalize-'))
    outFull = join(dir, 'full.ndjson')
    outDisplay = join(dir, 'display.ndjson')
    exclusions = join(dir, 'exclusions.json')
    await execFileAsync('node', [
      NORMALIZE,
      '--input',
      FIXTURE,
      '--partition',
      'LFP3',
      '--out-full',
      outFull,
      '--out-display',
      outDisplay,
      '--exclusions',
      exclusions
    ])
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function readNdjson(path) {
    return fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  }

  it('keeps only the two non-excluded sites, exploding the MultiPolygon', () => {
    const records = readNdjson(outFull)
    const ids = records.map((r) => r.properties.siteId).sort()
    // KEEP-SMALL (1 component) + KEEP-BIG-HARDBAN (2 components) = 3 lines.
    expect(records).toHaveLength(3)
    expect(ids).toEqual(['KEEP-BIG-HARDBAN', 'KEEP-BIG-HARDBAN', 'KEEP-SMALL'])
    expect(records.every((r) => r.geometry.type === 'Polygon')).toBe(true)
  })

  it('records per-reason drop counts in the exclusions manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(exclusions, 'utf8'))
    expect(manifest.drops.categoryId).toBe(1) // DROP-CAT9
    expect(manifest.drops.areaWithoutHardBan).toBe(1) // DROP-BIG
    expect(manifest.counts.featuresIn).toBe(4)
    expect(manifest.counts.kept).toBe(2)
    expect(manifest.counts.componentsFull).toBe(3)
  })

  it('display stream rounds coordinates while keeping the same feature count', () => {
    const display = readNdjson(outDisplay)
    expect(display).toHaveLength(3)
    const small = display.find((r) => r.properties.siteId === 'KEEP-SMALL')
    // -70.123456 in the fixture rounds to -70.12346 (5 dp) on the display stream.
    expect(small.geometry.coordinates[0][0][0]).toBe(-70.12346)
  })

  it('excludes the whole HighSeas partition without reading features', async () => {
    const hsFull = join(dir, 'hs-full.ndjson')
    const hsDisplay = join(dir, 'hs-display.ndjson')
    const hsExcl = join(dir, 'hs-excl.json')
    await execFileAsync('node', [
      NORMALIZE,
      '--input',
      FIXTURE,
      '--partition',
      'HighSeas',
      '--out-full',
      hsFull,
      '--out-display',
      hsDisplay,
      '--exclusions',
      hsExcl
    ])
    expect(fs.readFileSync(hsFull, 'utf8')).toBe('')
    const manifest = JSON.parse(fs.readFileSync(hsExcl, 'utf8'))
    expect(manifest.excludedPartition).toBe(true)
    expect(manifest.drops.partition).toBe(1)
  })
})

describe('flattenForFgb — FlatGeobuf has no list/struct column type', () => {
  it('JSON-stringifies exactly the non-scalar fields, leaving scalars untouched', () => {
    const props = {
      siteId: 'X1',
      name: 'Test',
      lfp: 3,
      restrictions: { anchoring: 'prohibited' },
      raw: { anchoring: 'prohibited' },
      sourceUrls: ['https://a', 'https://b'],
      siteVersion: { major: 2, minor: 0 }
    }
    const flat = flattenForFgb(props)
    for (const field of FGB_JSON_FIELDS) {
      expect(typeof flat[field]).toBe('string')
    }
    // Scalars survive as-is.
    expect(flat.siteId).toBe('X1')
    expect(flat.lfp).toBe(3)
    // Round-trips losslessly.
    expect(JSON.parse(flat.restrictions)).toEqual({ anchoring: 'prohibited' })
    expect(JSON.parse(flat.sourceUrls)).toEqual(['https://a', 'https://b'])
    expect(JSON.parse(flat.siteVersion)).toEqual({ major: 2, minor: 0 })
  })

  it('processFeature output carries only FGB-writable property values', () => {
    const feature = {
      type: 'Feature',
      properties: {
        SITE_ID: 'Y1',
        site_name: 'Y',
        category_name: 'Marine Protected Area',
        anchoring: 1
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0]
          ]
        ]
      }
    }
    const out = processFeature(feature)
    const props = out.full[0].properties
    // Nothing left as an object/array — ogr2ogr would otherwise reject the layer.
    for (const [, v] of Object.entries(props)) {
      expect(Array.isArray(v) || (v !== null && typeof v === 'object')).toBe(false)
    }
  })
})
