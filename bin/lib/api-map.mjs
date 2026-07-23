/**
 * Adapter: Navigator API V2 site responses -> the download GeoJSON schema.
 *
 * The mirror stores features in the schema of the bulk Navigator download
 * (the property names normalize.mjs/decode.mjs consume), so the whole build
 * pipeline is source-agnostic. API records differ from download records in
 * exactly three ways, all verified against the same site fetched both ways
 * (test/fixtures/api/detail-AIISR33.json vs the staged 052826 download):
 *
 *   1. Every numeric value comes back as a string ("1", not 1).
 *   2. The identifier maps to SITE_ID with `ps_id ?? site_id` precedence (search
 *      now returns the canonical ps_id; site_id lingers as a deprecated duplicate),
 *      and four fields are renamed (total_marine_area<->marine_area,
 *      percent_marine_area<->percent_marine, location_type<->site_location,
 *      tribal_exemptions<->tribal).
 *   3. Boundary coordinates carry a Z (always 0); the download is 2D.
 *
 * The activity coding key is IDENTICAL (0=allowed, 1=PROHIBITED, 2=restricted,
 * 3=unknown, null=not-yet-coded) — see mapping.json.
 *
 * Boundary geometries sourced from MarViva, WDPA, or the CBD CHM are withheld
 * by the API (their redistribution restrictions): `site_boundary` comes back
 * null/empty. The caller keeps the previously mirrored geometry in that case.
 */

/**
 * API field name -> download field name. The site identifier is resolved
 * separately (ps_id/site_id, below) with explicit precedence, so it is NOT in
 * this table — a rename map can't express "ps_id wins over site_id" and, keyed
 * by the same target, would let whichever appears last in the API object clobber
 * the other.
 */
const API_SITE_ID_FIELDS = new Set(['ps_id', 'site_id'])

const RENAME_API_TO_DOWNLOAD = {
  total_marine_area: 'marine_area',
  percent_marine_area: 'percent_marine',
  location_type: 'site_location',
  tribal_exemptions: 'tribal'
}

/** API-only fields that have no download column; never enter the mirror. */
const API_ONLY_FIELDS = new Set([
  'ogc_fid',
  'regulation_type',
  'latest_updates',
  'last_update',
  'bounds',
  'site_boundary',
  'type',
  'resType'
])

/**
 * Download-only columns the API does not return. Present (as null) in every
 * adapted record so mirror records keep one stable column set regardless of
 * source. other_helpful_links is the only one decode.mjs reads (an optional
 * source URL); the rest are versioning/GIS bookkeeping the pipeline ignores.
 */
const DOWNLOAD_ONLY_FIELDS = [
  'OBJECTID',
  'other_helpful_links',
  'version_start_date',
  'version_end_date',
  'change_type_legal',
  'change_type_gis',
  'coastline_match',
  'Shape_Length',
  'Shape_Area'
]

/**
 * Download columns that hold numbers. API values for these are coerced from
 * string. wdpa_id is deliberately NOT here: it is type-unstable upstream
 * (composite "555542441; 555637321", suffixed "102534_B") and must never be
 * Number()-parsed — decode.mjs normalizes it as a string.
 */
const NUMERIC_FIELDS = new Set([
  'lfp',
  'tribal',
  'subzone',
  'site_major_version',
  'site_minor_version',
  'modification_level',
  'total_area',
  'marine_area',
  'percent_marine',
  'site_location',
  'year_est',
  // the 43 coded activity/gear columns (mapping.json key)
  'recreational_fishing',
  'commercial_fishing',
  'artisanal_fishing',
  'subsistence_fishing',
  'bottom_trawling',
  'pelagic_trawling',
  'hook_and_line',
  'trolling',
  'longlining',
  'nets',
  'purse_seine_rndhaul_surrd_nets',
  'gillnetting',
  'gillnets_entangling_nets',
  'trammel_nets',
  'dip_scoop_nets',
  'cast_nets',
  'drift_nets',
  'other_nets',
  'dredges',
  'traps_and_pots',
  'spear_fishing',
  'underwater_extraction_diving',
  'hand_capture',
  'fish_aggregating_devices',
  'misc_gear',
  'discharge',
  'speed',
  'entry',
  'diving',
  'removal_of_historic_artifacts',
  'stopping',
  'anchoring',
  'mooring',
  'dragging',
  'landing',
  'dredging',
  'dredging_dumping',
  'industr_or_mineral_exploration',
  'drilling',
  'non_fishing_industr_extraction',
  'aquaculture',
  'construction',
  'overflight_or_drones'
])

function coerceNumber(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Map one API site object's attributes into download-schema properties. */
export function apiSiteToDownloadProps(apiSite) {
  const props = {}
  // The identifier is now returned as ps_id in every API mode; site_id is a
  // deprecated duplicate. Resolve it explicitly (ps_id wins) and skip both raw
  // keys below so the deprecated value can never overwrite the canonical one.
  props.SITE_ID = apiSite.ps_id ?? apiSite.site_id ?? null
  for (const [apiKey, value] of Object.entries(apiSite)) {
    if (API_ONLY_FIELDS.has(apiKey) || API_SITE_ID_FIELDS.has(apiKey)) continue
    const key = RENAME_API_TO_DOWNLOAD[apiKey] ?? apiKey
    props[key] = NUMERIC_FIELDS.has(key) ? coerceNumber(value) : value
  }
  for (const key of DOWNLOAD_ONLY_FIELDS) {
    if (!(key in props)) props[key] = null
  }
  return props
}

/** Drop the constant-0 Z coordinate the API appends to every vertex. */
function stripZ(coordinates) {
  if (!Array.isArray(coordinates)) return coordinates
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number') {
    return [coordinates[0], coordinates[1]]
  }
  return coordinates.map(stripZ)
}

/**
 * Extract usable 2D geometry from an API detail/boundary response, or null
 * when the boundary is withheld (MarViva/WDPA/CBD CHM sources).
 */
export function apiGeometry(boundary) {
  if (!boundary || typeof boundary !== 'object') return null
  const { type, coordinates } = boundary
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null
  return { type, coordinates: stripZ(coordinates) }
}

/**
 * Build a mirror record (a download-schema GeoJSON Feature) from one
 * /api/detail/?export_boundaries=true response. `geometry: null` signals the
 * caller to keep the previously mirrored geometry for this site.
 */
export function apiDetailToMirrorFeature(detail) {
  return {
    type: 'Feature',
    properties: apiSiteToDownloadProps(detail),
    geometry: apiGeometry(detail.site_boundary)
  }
}
