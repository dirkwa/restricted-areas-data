# restricted-areas-data

Data pipeline that turns the ProtectedSeas Navigator GeoJSON dump into per-region
(ocean-basin) **FlatGeobuf** extracts, published as GitHub Release assets for the
[`signalk-restricted-areas`](https://github.com/dirkwa/signalk-restricted-areas)
plugin. No PMTiles in v1.

The raw Navigator download is terms-of-use gated and large (~2.5 GB zipped,
~6.7 GB expanded). It is never committed and never fetched by CI. A human runs
the gated steps; the workflow only transforms an already-staged raw zip.

## Pipeline

```
raw zip (staged)  ──normalize.mjs──▶  NDJSON (exploded, single-component)
                                          │
                                  region-tag.mjs
                                          │
                          per-region NDJSON  ──ogr2ogr──▶  <region>.fgb + <region>.display.fgb
                                          │
                          make-manifest.mjs  ──▶  manifest.json  +  LICENSE-DATA.md
```

- **`bin/normalize.mjs`** — decode the 43 coded columns, apply exclusions,
  explode `MultiPolygon` into single-component features, emit full + display
  NDJSON and a per-partition `exclusions.json` tally.
- **`bin/region-tag.mjs`** — route each component feature to exactly one region
  by testing its bbox-centroid against `regions/regions.geojson` (first match in
  array order wins). Antimeridian-spanning components resolve to `sw-pacific`;
  unmatched centroids go to an `other` bucket (logged, never dropped).
- **`bin/region-meta.mjs`** — bbox + feature count per region (manifest sidecar).
- **`bin/build-index.mjs`** / **`bin/make-manifest.mjs`** — assemble and emit
  `manifest.json` (sha256, size, bbox, featureCount per asset; license,
  citations, disclaimer, attribution, exclusion tallies).
- **`bin/check-upstream.mjs`** — monthly probe comparing Navigator's advertised
  dataset date to the published manifest; opens one tracking issue when newer.

## Ingest runbook

This is the only part that needs a human, because of the I-AGREE click-through.

1. **Accept the terms and download.** Go to
   https://navigatormap.org/data-request, read and accept the Terms of Use
   (the I-AGREE step), and download the GeoJSON dataset. Note the dataset date
   shown on the page and the date you downloaded.
2. **Stage the raw zip.** Create a staging GitHub Release (e.g. tag
   `raw-2026.05`) and upload the unmodified Navigator zip as its only asset.
   Staging keeps the gated bytes out of git while making them reachable by the
   workflow's `GITHUB_TOKEN`.
3. **Dispatch the build.** Run the `build.yml` workflow
   (Actions ▸ build ▸ Run workflow) with:
   - `raw_release_tag` — the staging tag from step 2 (`raw-2026.05`)
   - `dataset_date` — the date from the data-request page (ISO, e.g. `2026-05-28`)
   - `download_date` — the date you clicked I-AGREE (ISO)
   - `version_tag` — the release to publish (e.g. `v2026.05`)
4. **Verify.** The workflow publishes `<version_tag>` with the regional FGBs,
   `manifest.json`, and `LICENSE-DATA.md`. The plugin consumes `manifest.json`.

The `check-upstream` workflow runs monthly and opens an `upstream-update` issue
when Navigator advertises a newer dataset date than the published manifest. It
does not download anything; ingestion stays a deliberate human action.

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
