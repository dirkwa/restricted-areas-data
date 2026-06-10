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

```
prepare      stream-unzip each member → normalize.mjs (decode + exclusions +
             MultiPolygon explode) → region-tag.mjs → per-region NDJSON + exclusions.json
build-region (matrix, one per region) NDJSON → FlatGeobuf (full + display variants);
             sub-split guard if a region FGB would exceed the 2 GB asset limit;
             emit a <region>.meta.json sidecar (bbox + featureCount)
publish      build-index + make-manifest.mjs → manifest.json + LICENSE-DATA.md;
             gh release create <version_tag> with the FGBs + manifest
```

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
- [bin/check-upstream.mjs](bin/check-upstream.mjs) — download-free: scrapes the data-request
  page for the dataset date, compares to the published manifest, signals when newer (drives the
  monthly issue-opening cron).
- [mapping.json](mapping.json) — the load-bearing decode + exclusion contract, shared in spirit
  with the plugin's schema.ts.
- [regions/regions.geojson](regions/regions.geojson), [pipeline.config.json](pipeline.config.json),
  [pipeline.config.schema.json](pipeline.config.schema.json) — region polygons + tunables.
- [.github/workflows/build.yml](.github/workflows/build.yml) — `workflow_dispatch` (inputs:
  raw_release_tag, dataset_date, download_date, version_tag); the prepare → build-region →
  publish graph above.
- [.github/workflows/check-upstream.yml](.github/workflows/check-upstream.yml) — monthly cron;
  opens/updates ONE issue when upstream is newer. Never downloads.
- [test/](test/) — vitest over the bin scripts (decode golden, exclusion firing, MultiPolygon
  explode, region tagging incl. the Fiji/antimeridian case, manifest helpers, check-upstream).

## Ingest runbook (the human step)

The raw download is terms-gated. A maintainer downloads the Navigator GeoJSON zip from
`https://navigatormap.org/data-request` after clicking **"I AGREE"**, records the download
date (for the citation), uploads the zip to a private staging GitHub Release
(`staging-raw-<datecode>`), then dispatches `build.yml`. The dataset date code (e.g. `052826`
= 2026-05-28) becomes the version tag `v2026.05`.

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
