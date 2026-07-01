# restricted-areas-data

Data pipeline that turns the ProtectedSeas Navigator GeoJSON dump into per-region
(ocean-basin) **FlatGeobuf** extracts, published as GitHub Release assets for the
[`signalk-restricted-areas`](https://github.com/dirkwa/signalk-restricted-areas)
plugin. No PMTiles in v1.

The pipeline is **fully automated** after a one-time bootstrap: a weekly sync
keeps a dataset mirror current via the public
[Navigator Map API](https://protectedseas.gitbook.io/navigator-api-docs)
(following its recommended
[data-synchronization pattern](https://protectedseas.gitbook.io/navigator-api-docs/conventions/data-synchronization))
and republishes the regional extracts whenever upstream sites change. The bulk
Navigator download is only needed to (re)seed the mirror: it is terms-of-use
gated and large (~2.5 GB zipped, ~6.7 GB expanded), never committed, and never
fetched by CI — a human runs that gated step.

## Pipeline

```
                       ┌──────────────  one-time bootstrap  ─────────────┐
raw zip (staged)  ──seed-mirror.mjs──▶  dataset mirror (draft release:
                                        NDJSON.gz shards + mirror-index.json)
                                          ▲          │
            weekly: sync-mirror.mjs ──────┘          │  (on change)
            sweep API index, diff, refresh           │
            changed sites, upsert shards             ▼
                                  normalize.mjs ──▶ NDJSON (exploded, single-component)
                                          │
                                  region-tag.mjs
                                          │
                          per-region NDJSON  ──ogr2ogr──▶  <region>.fgb + <region>.display.fgb
                                          │
                          make-manifest.mjs  ──▶  manifest.json  +  LICENSE-DATA.md
```

- **`bin/seed-mirror.mjs`** / **`bin/make-mirror-state.mjs`** — bootstrap the
  mirror from a staged bulk download: one download-schema GeoJSON Feature per
  line, gzipped per partition, plus a compact `mirror-index.json`
  (`SITE_ID -> site version`) and a `mirror-state.json` provenance file. The
  mirror lives in a **draft** GitHub release (`mirror`), reachable by CI but
  not publicly listed.
- **`bin/sync-mirror.mjs`** — the weekly refresh (`sync.yml`): sweeps the full
  catalog index from the API (~55 paced requests), diffs against
  `mirror-index.json`, fetches details + boundaries for added/changed sites
  only, rewrites the shards, and triggers a rebuild + publish when anything
  moved. Paced to stay well inside the API's 5-requests-per-10-s limit; sanity
  guards refuse to sync from an implausible sweep (half-empty catalog, mass
  removals).
- **`bin/lib/api-client.mjs`** / **`bin/lib/api-map.mjs`** — paced/retrying API
  client and the API→download-schema field adapter (renames, string→number
  coercion, Z-coordinate strip). Sites whose boundary the API withholds
  (MarViva/WDPA/CBD CHM sources) keep their previously mirrored geometry.
- **`bin/normalize.mjs`** — decode the 43 coded columns, apply exclusions,
  explode `MultiPolygon` into single-component features, emit full + display
  NDJSON and a per-partition `exclusions.json` tally. Reads FeatureCollections
  (bulk download) or NDJSON (`--format ndjson`, mirror shards).
- **`bin/region-tag.mjs`** — route each component feature to exactly one region
  by testing its bbox-centroid against `regions/regions.geojson` (first match in
  array order wins). Antimeridian-spanning components resolve to `sw-pacific`;
  unmatched centroids go to an `other` bucket (logged, never dropped).
- **`bin/region-meta.mjs`** — bbox + feature count per region (manifest sidecar).
- **`bin/build-index.mjs`** / **`bin/make-manifest.mjs`** — assemble and emit
  `manifest.json` (sha256, size, bbox, featureCount per asset; license,
  citations, disclaimer, attribution, exclusion tallies).
- **`bin/check-upstream.mjs`** — monthly cross-check comparing Navigator's
  advertised dataset date to the published manifest; opens one tracking issue
  when upstream is newer than what the sync delivered (catches a lagging or
  broken sync).

Each release's `manifest.json` records its Navigator extract date
(`datasetDate`); the plugin surfaces that date to users so they always know the
release date of the data they are navigating with.

## Bootstrap runbook (seed or re-seed the mirror)

This is the only part that needs a human — obtaining a bulk export. Once the
mirror exists it is kept current automatically by the weekly API `sync`; a
re-seed is only needed for recovery, or if the locked partition exclusions ever
change. **Day to day you never touch this** — for a normal "upstream looks
newer" nudge, just dispatch `sync.yml` with `full=true` (a full API reconcile);
re-seed only if the API mirror is unrecoverable.

1. **Obtain a bulk export.** Request the full Navigator dataset via
   https://navigatormap.org/data-request (Navigator V2 routes bulk-data
   requests through Contact Us; the old self-serve I-AGREE download no longer
   exists). Note the dataset date (ProtectedSeas encodes it as `MMDDYY` in the
   ArcGIS layer name, e.g. `Navigator_AllSites_042426_…` = 2026-04-24) and the
   date you received it.
2. **Stage the raw zip.** Create a staging GitHub Release (e.g. tag
   `raw-2026.05`) and upload the unmodified Navigator zip as its only asset.
   Staging keeps the bytes out of git while making them reachable by the
   workflow's `GITHUB_TOKEN`.
3. **Seed the mirror.** Run the `seed-mirror.yml` workflow
   (Actions ▸ seed-mirror ▸ Run workflow) with:
   - `raw_release_tag` — the staging tag from step 2 (`raw-2026.05`)
   - `dataset_date` — the dataset date (ISO, e.g. `2026-05-28`)
   - `download_date` — the date you received the export (ISO)
4. **Publish.** Dispatch `build.yml` with `source: mirror`, a `version_tag`
   (e.g. `v2026.05`), and `publish: true` — or just let the next weekly `sync`
   run do it. The workflow publishes `<version_tag>` with the regional FGBs,
   `manifest.json`, and `LICENSE-DATA.md`. The plugin consumes `manifest.json`.

From then on the weekly `sync` workflow keeps everything current without human
involvement; `check-upstream` runs monthly as an independent cross-check and
opens an `upstream-update` issue if the published data ever lags what Navigator
advertises. `build.yml` can still build straight from a staged zip
(`source: staging-zip`) as a fallback.

## Exclusions

Navigator carries **28,058 features**. Most of the total area is a handful of
ocean-spanning overlays that are not navigation restrictions; carrying them would
bloat the regional FGBs and, worse, fire false geofence alerts across entire
ocean basins. The locked filters (`pipeline.config.json`) remove the area without
removing the restrictions:

| Filter | Removed | Why |
| --- | --- | --- |
| `excludeCategories: [9]` | 538 features / ~205M km² | Category 9 = Jurisdictional Authority Area (EEZ overlays). A jurisdiction boundary is not a restriction. |
| `excludePartitions: ['HighSeas']` | 704 features / ~1.18B km² | RFMO / basin-scale overlays spanning whole oceans. |
| `maxAreaKm2WithoutHardBan: 50000` | the remaining FMA/Other giants | Drop any polygon over 50,000 km² **unless** it carries a hard transit ban (`entry===1` or `anchoring===1`), so genuinely prohibited zones of any size are always kept. |

Net effect: **keep ~94% of features, remove ~99% of total area.** Inland-water
sites are kept by choice (small, low-harm, and they carry real restrictions).
Nothing is silently deleted — every removed feature is counted by reason and the
tallies are recorded in `manifest.json`'s `exclusions` block.

> ⚠️ **Coding key.** Every coded fishing/marine-activity column uses
> `0 = allowed, 1 = PROHIBITED, 2 = restricted, 3 = N/A or unknown, null = not-yet-coded`.
> `1` is the **ban**. A truthy test (`if (props.anchoring)`) inverts the safety
> meaning. Every column goes through `levelOf()`.

## Regions

`regions/regions.geojson` is a coarse ocean-basin tiling. A feature is assigned by
its bbox-centroid; regions overlap at the edges and array order resolves the
overlap (more specific basins listed first). Slugs match the plugin's region
config enum:

| Slug | Coverage |
| --- | --- |
| `mediterranean` | Mediterranean and Black Sea |
| `caribbean` | Caribbean and Gulf of Mexico |
| `sw-pacific` | SW Pacific incl. Fiji — **antimeridian-safe** (a MultiPolygon split at ±180) |
| `ne-pacific` | NE Pacific (North America west coast) |
| `se-pacific` | SE Pacific (South America west coast) |
| `nw-atlantic` | NW Atlantic |
| `ne-atlantic` | NE Atlantic incl. North Sea and Baltic |
| `indian-ocean` | Indian Ocean |

`sw-pacific` is authored as two polygons (one from +120 to +180, one from −180 to
−120) so a feature near the dateline — Fiji sits at both ~+179 and ~−179 — lands
in `sw-pacific` from either side. `region-tag.mjs` also routes any single
component whose bbox straddles ±180 to `sw-pacific` directly.

## Development

```sh
npm ci
npm run lint
npm run test
npm run format
```

## Attribution and licence

The published **data** is CC BY 4.0; the **code** in this repository is
Apache-2.0 (see `LICENSE`). The required data attribution is reproduced in
`LICENSE-DATA.md` and embedded in every release `manifest.json`:

> Data: ProtectedSeas Navigator (CC BY 4.0). Zetterlind, V. et al. (2025).
> Navigator - a global database of verified marine protected and managed area
> regulations and boundaries. Scientific Data, 12, 1212.
> https://doi.org/10.1038/s41597-025-05535-2 The ProtectedSeas Navigator Map of
> Conservation Regulations, ProtectedSeas®, https://map.navigatormap.org. Navigator
> Data Download, ProtectedSeas®. https://navigatormap.org/data-request.

**Disclaimer:** This is summary data and may be incomplete, inaccurate, or out of
date. It is NOT a legal or compliance document. Provided "as-is". Always verify
against official sources before relying on it for navigation or compliance.
