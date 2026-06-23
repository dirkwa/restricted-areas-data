# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing usage (the ingest
runbook, exclusion justification, attribution) lives in [README.md](README.md); this file is
the orientation an agent needs before making non-trivial changes.

## What this is

A data pipeline (GitHub Actions) that converts a **ProtectedSeas Navigator** GeoJSON download
into **regional, ocean-basin FlatGeobuf extracts** published as versioned GitHub Release
assets, consumed by the companion plugin
[`signalk-restricted-areas`](https://github.com/dirkwa/signalk-restricted-areas). Same
release-asset pattern as `dirkwa/signalk-gebco-charts`.

The input is large and terms-gated: the Navigator GeoJSON is ~2.5 GB zipped / ~6.7 GB
unzipped, split into 7 `FeatureCollection` members by Level-of-Fishing-Protection score
(LFP0–LFP5 + HighSeas). Geometry AND all 87 attributes are co-located in the GeoJSON — there
is no separate attribute join (the CSV in the delivery is redundant). **The raw download is
never committed** and cannot be auto-fetched (it requires an interactive "I AGREE" click).

## ⚠️ THE landmine — the activity coding key

Navigator codes every fishing + marine-activity column numerically:

```
0 = Allowed   1 = PROHIBITED   2 = Restricted   3 = N/A or Unknown   null = Not-Yet-Coded
```

**`1` means PROHIBITED.** [bin/lib/decode.mjs](bin/lib/decode.mjs) is a 1:1 mirror of the
plugin's `src/schema.ts`; the two MUST agree byte-for-byte so the on-boat decode matches the
published data. [mapping.json](mapping.json) is the human-readable contract and carries the
same warning at the top. A golden test in `test/normalize.test.mjs` asserts
`levelOf(1) === 'prohibited'`.

## Pipeline shape

A streaming job graph. The expensive global pass runs once; per-region work fans out.
Since the API-sync rework the build is **source-agnostic**: it consumes either a staged
bulk download zip or the **dataset mirror** that the weekly sync keeps current.

```
seed (once)  stream-unzip each member → seed-mirror.mjs → NDJSON.gz mirror shards +
             mirror-index.json (+state) → DRAFT release `mirror` (not publicly listed)
sync (weekly) sync-mirror.mjs: sweep the full API catalog index (~55 paced req) →
             diff vs mirror-index → fetch detail+boundary per added/changed site →
             rewrite shards (refreshed sites land in updates.ndjson.gz) → upload →
             on change: call build.yml (workflow_call) with publish=true
prepare      (staging-zip) stream-unzip member → normalize.mjs, or
             (mirror) gunzip shard → normalize.mjs --format ndjson
             → region-tag.mjs → per-region NDJSON + exclusions.json + provenance.json
build-region (matrix, one per region) NDJSON → FlatGeobuf (full + display variants);
             sub-split guard if a region FGB would exceed the 2 GB asset limit;
             emit a <region>.meta.json sidecar (bbox + featureCount)
publish      build-index + make-manifest.mjs → manifest.json + LICENSE-DATA.md;
             gh release create <version_tag> with the FGBs + manifest
```

### The mirror + API sync (the automation layer)

- The mirror stores **download-schema** GeoJSON Features (one per line, gzipped per
  partition). API responses are adapted INTO that schema by
  [bin/lib/api-map.mjs](bin/lib/api-map.mjs) — renames (`ps_id→SITE_ID`,
  `total_marine_area→marine_area`, `percent_marine_area→percent_marine`,
  `location_type→site_location`, `tribal_exemptions→tribal`), string→number coercion
  (the API stringifies every numeric; wdpa_id is deliberately NOT coerced), and
  Z-coordinate strip (API boundaries are 3D). The adapter is pinned by a golden test
  against a real API response verified field-by-field against the same site in the
  bulk download.
- The API uses the SAME activity coding key as the download (0/1/2/3/null, 1=PROHIBITED).
- Rate limit: 5 requests / 10 s per IP. ALL API traffic goes through
  [bin/lib/api-client.mjs](bin/lib/api-client.mjs) (serialized, 2.5 s spacing, backoff).
  Never call the API outside it.
- Change detection has TWO paths (both in `run()` in sync-mirror.mjs), chosen per run:
  - **INCREMENTAL** (weekly default): `changedSinceRows(lastSweepDate)` pages
    `search?type=sites_updated&changed_since=...&include_inactive=true`, which reports new
    sites + corrections as ACTIVE rows and deletions as `status:"removed"` rows.
    `deriveDelta` classifies them against the carried mirror; `patchIndex` PATCHES the
    index forward (NEVER rebuild — sites_updated is not a census, it only returns sites
    whose last_update is in the window; the ~28k untouched baseline must carry forward).
    `assertSaneDelta` caps removals only. A quiet week ≈ 1 request.
  - **CENSUS** (~monthly via `lastFullCensusDate`, on stale/absent baseline, or `--full`):
    `sweepIndex` + `diffIndex` + `assertSaneSweep` (the half-empty + mass-removal guards
    are MEANINGFUL here). The census is the only self-heal for anything the incremental
    stream silently misses (truncated page, sub-cap removal drip) and the only pruner of a
    site silently flipped to high-seas — keep it. It still unions a `changedSinceRows` pass
    because `site_major/minor_version` moves ONLY on regulation/boundary changes, not on
    attribute/coding corrections (the safety-critical case: a `1`=PROHIBITED that gets
    fixed). Do NOT drop either prong.
  - Invariants verified live, do not relitigate: `changed_since` is inclusive (`>=`);
    `sites_updated` pagination is stable under `sort=NAME_ASC`; `last_update` is
    day-granular (so a (version,date) equality skip is UNSAFE — every active in-mirror row
    is re-fetched, idempotency comes from overwrite); `include_inactive` rows carry a
    `status` field and `assertInactiveFlagHonored` hard-fails if a non-empty window lacks
    it (flag regression would make removals invisible). "In the mirror" = index ∪
    geometryUnavailable; removals clean BOTH stores; a parked withheld site that the window
    returns active is force-fetched, never run through the version-unchanged skip.
- Boundaries from MarViva/WDPA/CBD CHM sources are withheld by the API: changed sites
  keep their previously mirrored geometry; NEW sites without geometry wait in
  mirror-state.geometryUnavailable as `{SITE_ID: {v: [major, minor]}}` and are re-fetched
  ONLY when their catalog version moves past the recorded one (the live system carries
  ~1,600 such sites — most of the API catalog's surplus over the bulk download — and
  re-fetching them weekly would cost ~70 min of paced requests for nothing).
- Excluded partitions (HighSeas) are not mirrored at all — re-seed from a fresh bulk
  download if mapping.json's partition exclusion is ever unlocked. The API catalog has no
  partition concept, so the sync mirrors that exclusion by country: sweep entries with
  `country === 'High Seas / International'` (verified: 701/704 of the HighSeas member,
  zero false positives elsewhere) are never diffed, fetched, or indexed
  ([bin/lib/partition.mjs](bin/lib/partition.mjs) `isHighSeasCountry`).

No PMTiles in v1 — Freeboard consumes the polygons via the plugin's Resources API, so no tile
layer is built. With the exclusions applied (below), regional FGBs stay well under the asset
limit and a standard runner suffices.

## Exclusions (locked defaults)

Applied in `normalize.mjs` from [pipeline.config.json](pipeline.config.json) /
`mapping.json.exclude`, so the giant low-value polygons never reach the boat. Filtered, not
silently deleted — per-reason counts go into the manifest.

- `categoryId === 9` (Jurisdictional Authority / EEZ) — an EEZ is not a restriction.
- The whole `HighSeas` partition — RFMO/ocean-basin overlays.
- Any polygon with `marine_area > 50000` km² that does NOT have a hard transit ban
  (`entry === 1` or `anchoring === 1`) — catches ocean-basin Fisheries-Management/Other giants
  regardless of the free-text category label, while protecting every genuinely-prohibited zone.
- Any feature whose whole-geometry bbox spans `> 90°` in lon OR lat without a hard ban
  (`maxBboxSpanDegWithoutHardBan`) — the planet-spanning "Policies" overlays (IMO, WTO, BBNJ,
  Marine Oil Pollution Convention, …) carry `marine_area = null`, so the km² cap can't see them;
  the span cap does. These must be excluded at the FEATURE level (not per component) because some
  are MultiPolygons mixing a planet-wide ring with smaller ones. ~9 features; each would otherwise
  match every point on Earth.

Inland-water sites are KEPT (small, low-harm, carry real restrictions). Real measured impact over
the full dataset: 538 EEZ + 477 oversized + the planet-spanning overlays dropped; 27,043 of 28,058
sites kept → 166,213 components.

## Regions are GEOGRAPHIC

[regions/regions.geojson](regions/regions.geojson) defines 12 ocean-basin regions; a vessel
loads only the basin(s) it sails. **LFP is a per-zone filter attribute, not a region axis** —
the LFP partitioning of the raw download is just packaging. The full globe is covered (validated:
0 features fall to `other`). The `sw-pacific` region is a MultiPolygon so it is antimeridian-safe
(Fiji at E179/W179 lands in one region); `region-tag.mjs` resolves antimeridian-spanning centroids
there.

**The feature ORDER in `regions.geojson` is the overlap-resolution contract** — `region-tag.mjs`
assigns each zone to the first region that contains it, so don't reorder casually:
`southern-ocean, mediterranean, caribbean, north-europe, nw-pacific, sw-pacific, ne-pacific,
se-pacific, south-atlantic, nw-atlantic, ne-atlantic, indian-ocean`.

The **set of slugs** (not their order) is a cross-repo contract — it must match `REGION_SLUGS` in
the plugin's `src/index.ts`. The plugin's array order is only the config-dropdown order and does
not affect tagging.

## File layout

- [bin/normalize.mjs](bin/normalize.mjs) — streaming SAX normalize (stream-json over
  `features[*]`; NEVER `JSON.parse` the whole 3 GB file). Decodes via decode.mjs, derives
  `categoryId`, applies exclusions, explodes MultiPolygons to per-component features, emits two
  NDJSON streams (`full` for geofencing, `display` rounded to 5 dp) + an `exclusions.json`.
- [bin/lib/decode.mjs](bin/lib/decode.mjs) — the shared decode (mirror of the plugin's
  schema.ts). `levelOf`, coarse-activity coalescing, special fields, `categoryIdOf`.
- [bin/region-tag.mjs](bin/region-tag.mjs) — assigns each component feature to exactly one
  region by bbox-centroid point-in-polygon against regions.geojson; writes per-region NDJSON.
- [bin/region-meta.mjs](bin/region-meta.mjs) — streams a region NDJSON to compute its bbox +
  featureCount (a build-region sidecar).
- [bin/build-index.mjs](bin/build-index.mjs) — folds the per-region `.meta.json` sidecars into
  the make-manifest index.
- [bin/make-manifest.mjs](bin/make-manifest.mjs) — builds `manifest.json` (version, dataset/
  download dates, per-region asset name/size/sha256/bbox/featureCount, exclusion counts, the
  CC BY 4.0 attribution + 3 citations + disclaimer). The plugin downloads this to discover the
  available regions.
- [bin/merge-exclusions.mjs](bin/merge-exclusions.mjs) — sums per-partition exclusion tallies.
- [bin/seed-mirror.mjs](bin/seed-mirror.mjs) + [bin/make-mirror-state.mjs](bin/make-mirror-state.mjs)
  — bootstrap the mirror shards/index/state from a staged bulk download (streaming).
- [bin/sync-mirror.mjs](bin/sync-mirror.mjs) — the weekly API sync orchestrator (sweep →
  diff → refresh → shard rewrite → upload → GH-Actions outputs). Uses the gh CLI.
- [bin/sweep.mjs](bin/sweep.mjs) — catalog index sweep + diff + sanity guards.
- [bin/lib/api-client.mjs](bin/lib/api-client.mjs) / [bin/lib/api-map.mjs](bin/lib/api-map.mjs)
  — paced API client and the API→download-schema adapter (see automation layer above).
- [bin/check-upstream.mjs](bin/check-upstream.mjs) — download-free: scrapes the data-request
  page for the dataset date, compares to the published manifest, signals when newer (now a
  monthly cross-check that the weekly API sync isn't lagging/broken).
- [mapping.json](mapping.json) — the load-bearing decode + exclusion contract, shared in spirit
  with the plugin's schema.ts.
- [regions/regions.geojson](regions/regions.geojson), [pipeline.config.json](pipeline.config.json),
  [pipeline.config.schema.json](pipeline.config.schema.json) — region polygons + tunables.
- [.github/workflows/build.yml](.github/workflows/build.yml) — `workflow_dispatch` +
  `workflow_call` (inputs: source staging-zip|mirror, version_tag, publish, …); the
  prepare → build-region → publish graph above.
- [.github/workflows/seed-mirror.yml](.github/workflows/seed-mirror.yml) — one-time/recovery
  bootstrap: staged raw zip → draft `mirror` release.
- [.github/workflows/sync.yml](.github/workflows/sync.yml) — weekly cron (Mon 06:23 UTC) +
  dispatch (with dry_run): sync-mirror.mjs, then calls build.yml with publish=true when
  anything changed. Opens/updates a `sync-failure` issue on failure.
- [.github/workflows/check-upstream.yml](.github/workflows/check-upstream.yml) — monthly cron;
  opens/updates ONE issue when upstream is newer. Never downloads.
- [test/](test/) — vitest over the bin scripts (decode golden, exclusion firing, MultiPolygon
  explode, region tagging incl. the Fiji/antimeridian case, manifest helpers, check-upstream).

## Bootstrap runbook (the human step)

Only the mirror seed needs a human; everything after is the weekly sync. The raw download is
terms-gated: a maintainer downloads the Navigator GeoJSON zip from
`https://navigatormap.org/data-request` after clicking **"I AGREE"**, records the download
date (for the citation), uploads the zip to a private staging GitHub Release
(`staging-raw-<datecode>`), then dispatches `seed-mirror.yml`. First publish: dispatch
`build.yml` with `source: mirror` + `publish: true` (auto tags use `vYYYY.MM.DD`), or wait
for the next weekly sync to find a change.

## Build, lint, test

```bash
npm run lint       # eslint check
npm test           # vitest
npm run build:all  # lint + test
```

`work/`, `dist/`, `*.fgb`, `*.ndjson`, and any `Navigator_*` file are gitignored — the raw
data and all derived artifacts NEVER enter git.

## Gotchas

- **Never `JSON.parse` an input member.** LFP1 is 3 GB. Stream with `stream-json`.
- **Decode parity.** decode.mjs ↔ the plugin's schema.ts must stay in lockstep; mapping.json
  documents the contract. Change one, change all three.
- **stream-json is CommonJS** — imported via its default export and destructured.
- **Attribution is duplicated, not imported**, from the plugin's attribution.ts (the two repos
  publish independently). If the citation/disclaimer text changes, update both.
- **No /tmp for scratch.** `/tmp` is tmpfs (RAM) on the dev box; tests write to a disk-backed
  scratch dir (gitignored).
