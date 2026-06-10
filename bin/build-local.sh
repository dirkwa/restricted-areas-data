#!/usr/bin/env bash
#
# build-local.sh — run the whole pipeline on a local Navigator zip, on disk,
# with NO network and NO publishing. Produces dist/<region>.{fgb,display.fgb},
# dist/manifest.json, dist/LICENSE-DATA.md.
#
# The raw Navigator zip stays on this machine — we deliberately do NOT upload it
# anywhere (the Terms of Use put redistribution liability on the downloader; see
# README "Data redistribution"). Use this for M0 / local iteration.
#
# Usage:
#   bin/build-local.sh \
#     --zip   /path/to/Navigator_AllSites_<MMDDYY>_JSON.zip \
#     --dataset-date 2026-05-28 \
#     --download-date 2026-06-10 \
#     --version v2026.05 \
#     [--work ./work] [--dist ./dist]
#
# Requires: node, unzip, jq, and GDAL's ogr2ogr on PATH (GDAL >= 3.8).
set -euo pipefail

ZIP="" DATASET_DATE="" DOWNLOAD_DATE="" VERSION=""
WORK="./work" DIST="./dist"
JOBS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2 ;;
    --dataset-date) DATASET_DATE="$2"; shift 2 ;;
    --download-date) DOWNLOAD_DATE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --dist) DIST="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Default concurrency: leave one core free. The normalize + FGB phases are
# per-partition / per-region independent, so they parallelize cleanly.
if [ -z "$JOBS" ]; then
  CORES="$(nproc 2>/dev/null || echo 4)"
  JOBS=$(( CORES > 1 ? CORES - 1 : 1 ))
fi

# Run the given command in the background, but first block until fewer than
# $JOBS background jobs are active (bounded concurrency, no GNU parallel needed).
throttle() {
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
}

for required in ZIP DATASET_DATE DOWNLOAD_DATE VERSION; do
  if [ -z "${!required}" ]; then
    echo "missing required --$(echo "$required" | tr 'A-Z_' 'a-z-')" >&2
    exit 1
  fi
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

for tool in node unzip jq ogr2ogr; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

# /tmp is tmpfs (RAM) on this box; the unzipped GeoJSON is multi-GB. Keep all
# work on disk under --work (a repo-local, gitignored dir by default).
mkdir -p "$WORK/regions" "$DIST"

echo "==> Normalize (${JOBS} parallel; streaming each zip member, never expanding 6.7 GB at once)"
# Each member is an independent FeatureCollection; stream it straight into
# normalize.mjs so the full expansion never lands on disk. Members run in
# parallel (each gets its own read-only unzip of the shared zip).
for member in $(unzip -Z1 "$ZIP" | grep -E '\.json$'); do
  partition="$(basename "$member" .json)"
  throttle
  (
    echo "    - $partition"
    unzip -p "$ZIP" "$member" \
      | node bin/normalize.mjs \
          --partition "$partition" \
          --out-full "$WORK/$partition.full.ndjson" \
          --out-display "$WORK/$partition.display.ndjson" \
          --exclusions "$WORK/$partition.exclusions.json"
  ) &
done
wait

echo "==> Route components into regions (full + display variants)"
cat "$WORK"/*.full.ndjson | node bin/region-tag.mjs --outdir "$WORK/regions" --suffix full
cat "$WORK"/*.display.ndjson | node bin/region-tag.mjs --outdir "$WORK/regions" --suffix display
node bin/merge-exclusions.mjs "$WORK"/*.exclusions.json > "$WORK/exclusions.json"

echo "==> NDJSON -> FlatGeobuf (${JOBS} parallel; full + display per region)"
# FlatGeobuf has no list/struct column type, so normalize already JSON-encoded the
# non-scalar fields; ogr2ogr writes them as plain strings. Display geometry was
# coordinate-rounded upstream in normalize (FGB ignores COORDINATE_PRECISION).
# Regions are independent — build them in parallel.
for src in "$WORK"/regions/*.full.ndjson; do
  [ -e "$src" ] || { echo "    (no regions produced)"; break; }
  region="$(basename "$src" .full.ndjson)"
  throttle
  (
    echo "    - $region"
    ogr2ogr -f FlatGeobuf "$DIST/$region.fgb" "GeoJSONSeq:$src"
    ogr2ogr -f FlatGeobuf "$DIST/$region.display.fgb" "GeoJSONSeq:$WORK/regions/$region.display.ndjson"
    node bin/region-meta.mjs --region "$region" --input "$src" > "$DIST/$region.meta.json"
  ) &
done
wait

echo "==> Build manifest"
node bin/build-index.mjs \
  --dist "$DIST" \
  --exclusions "$WORK/exclusions.json" \
  --generated-from "local:$(basename "$ZIP")" \
  > "$DIST/index.json"
node bin/make-manifest.mjs \
  --index "$DIST/index.json" \
  --version "$VERSION" \
  --dataset-date "$DATASET_DATE" \
  --download-date "$DOWNLOAD_DATE" \
  --generated-from "local:$(basename "$ZIP")" \
  > "$DIST/manifest.json"
cp LICENSE-DATA.md "$DIST/LICENSE-DATA.md"

echo
echo "Done. Local-only build — nothing was uploaded or published."
echo "  manifest : $DIST/manifest.json"
echo "  assets   : $(ls "$DIST"/*.fgb 2>/dev/null | wc -l) FlatGeobuf file(s) in $DIST/"
echo "  exclusions tallied in: $WORK/exclusions.json"
