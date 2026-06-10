/**
 * Shared decode of ProtectedSeas Navigator coded columns. This is a 1:1 mirror
 * of the plugin's src/schema.ts so the pipeline and the runtime agree byte-for-byte
 * on what every polygon means. Keep the two in lockstep.
 *
 * THE CODING KEY: 0=allowed, 1=PROHIBITED, 2=restricted, 3=unknown, null=na.
 * `1` is the ban, not "present/ok". A truthy test inverts every restriction.
 */

/** v===1 is PROHIBITED. Mirror of schema.ts; the golden test pins levelOf(1). */
export function levelOf(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (n === 0) return 'allowed'
  if (n === 1) return 'prohibited'
  if (n === 2) return 'restricted'
  if (n === 3) return 'unknown'
  return 'na'
}

/** Lower rank = more severe, for "more restrictive wins" coalescing. */
const LEVEL_RANK = {
  prohibited: 0,
  restricted: 1,
  allowed: 2,
  unknown: 3,
  na: 4
}

export function moreRestrictive(a, b) {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b
}

/** The 25 raw fishing/gear columns folded into the `fishing` rollup. */
const FISHING_COLUMNS = [
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
  'misc_gear'
]

/** The 18 raw non-fishing marine-activity columns. */
const ACTIVITY_COLUMNS = [
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
]

/** All 43 coded columns, for the lossless `raw` passthrough. */
const ALL_CODED_COLUMNS = [...FISHING_COLUMNS, ...ACTIVITY_COLUMNS]

/** Area Categories label -> numeric id (xlsx "Area Categories" sheet). */
const CATEGORY_LABEL_TO_ID = {
  'Marine Protected Area': 1,
  'Other Effective Area-Based Conservation Area': 2,
  'Fisheries Management Area': 3,
  'Water Quality/Human Health Area': 4,
  'Recreational Area': 5,
  'Vessel Restricted Area': 6,
  'Vessel Reporting Area': 7,
  'Voluntary Conservation Measure Area': 8,
  'Jurisdictional Authority Area': 9,
  Other: 10,
  'To Be Determined': 11
}

export function categoryIdOf(label) {
  if (typeof label !== 'string') return 'unknown'
  return CATEGORY_LABEL_TO_ID[label] ?? 'unknown'
}

function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * wdpa_id is type-unstable (number, "0", composite "555542441; 555637321",
 * "102534_B"). Coerce to string; "0"/""/0/null mean absent. NEVER Number()-parse.
 */
function normalizeWdpaId(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '' || s === '0') return null
  return s
}

function normalizeIucn(v) {
  const s = str(v)
  if (s === null || s === 'Unassigned') return null
  return s
}

/** tribal: Yes(0) -> exemption true, No(1) -> false, else null. Boolean, not a Level. */
function normalizeTribalExemption(v) {
  const n = num(v)
  if (n === 0) return true
  if (n === 1) return false
  return null
}

function cleanText(v) {
  const s = str(v)
  if (s === null) return null
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function composeSummary(props) {
  const parts = [
    cleanText(props.purpose),
    cleanText(props.restrictions),
    cleanText(props.allowed)
  ].filter((p) => p !== null)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Read a coded column by KEY (never by existence) and decode. */
function level(props, key) {
  return levelOf(props[key])
}

/** Worst (most restrictive) level over a set of columns. */
function worst(props, keys) {
  let acc = 'na'
  for (const k of keys) acc = moreRestrictive(acc, level(props, k))
  return acc
}

/** Decode the 12 coarse activities from raw props, with V1/V2 coalescing. */
export function coarseRestrictions(props) {
  return {
    anchoring: level(props, 'anchoring'),
    mooring: level(props, 'mooring'),
    entry: level(props, 'entry'),
    speed: level(props, 'speed'),
    diving: level(props, 'diving'),
    discharge: level(props, 'discharge'),
    dredging: moreRestrictive(level(props, 'dredging'), level(props, 'dredging_dumping')),
    removalOfArtifacts: level(props, 'removal_of_historic_artifacts'),
    fishingRecreational: level(props, 'recreational_fishing'),
    fishingCommercial: level(props, 'commercial_fishing'),
    fishingArtisanal: moreRestrictive(
      level(props, 'artisanal_fishing'),
      level(props, 'subsistence_fishing')
    ),
    fishing: worst(props, FISHING_COLUMNS)
  }
}

/** Decode all 43 raw columns losslessly (key -> level). */
function rawLevels(props) {
  const out = {}
  for (const k of ALL_CODED_COLUMNS) out[k] = level(props, k)
  return out
}

/**
 * Normalize a raw Navigator feature's `properties`. Same shape as schema.ts
 * RestrictedZoneProps minus `attribution` — the pipeline carries no citation
 * string per-feature (it lives in the release manifest, not every polygon).
 */
export function normalizeProps(props) {
  const sourceUrls = [
    str(props.url),
    str(props.regulation_source),
    str(props.other_helpful_links)
  ].filter((u) => u !== null)
  return {
    siteId: String(props.SITE_ID ?? props.site_id ?? ''),
    name: str(props.site_name) ?? '(unnamed area)',
    country: str(props.country),
    state: str(props.state),
    authority: str(props.managing_authority),
    designation: str(props.designation),
    category: str(props.category_name),
    categoryId: categoryIdOf(props.category_name),
    wdpaId: normalizeWdpaId(props.wdpa_id),
    iucnCat: normalizeIucn(props.iucn_cat),
    lfp: num(props.lfp),
    tribalExemption: normalizeTribalExemption(props.tribal),
    restrictions: coarseRestrictions(props),
    raw: rawLevels(props),
    summary: composeSummary(props),
    sourceUrls: [...new Set(sourceUrls)],
    season: str(props.season),
    effectiveFrom: str(props.effective_from),
    effectiveTo: str(props.effective_to),
    siteVersion: { major: num(props.site_major_version), minor: num(props.site_minor_version) }
  }
}
