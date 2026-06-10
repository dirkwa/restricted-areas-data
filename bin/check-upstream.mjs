#!/usr/bin/env node
/**
 * check-upstream: decide whether Navigator has a newer dataset than we last
 * published. Scrapes the data-request page for an ISO dataset date, reads the
 * datasetDate from our latest published release manifest, and writes
 * GitHub-Actions outputs (newer / upstream_date / published_date). Download-free.
 *
 * Both lookups are tolerant: a missing/unreadable manifest is treated as "no
 * published date" (so any upstream date counts as newer), and a page with no
 * recognizable date yields newer=false rather than a spurious issue.
 */

import { fileURLToPath } from 'node:url'

const DATA_REQUEST_URL = 'https://navigatormap.org/data-request'
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/

/** Extract the most recent ISO date mentioned on the page (newest wins). */
function parseUpstreamDate(html) {
  const dates = [...html.matchAll(new RegExp(ISO_DATE, 'g'))].map((m) => m[1])
  if (dates.length === 0) return null
  return dates.sort().at(-1)
}

/** String ISO dates compare correctly lexicographically; null published = always newer. */
function isNewer(upstream, published) {
  if (!upstream) return false
  if (!published) return true
  return upstream > published
}

async function fetchText(url) {
  const res = await globalThis.fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.text()
}

/** Read datasetDate from the latest release's manifest.json via the gh CLI. */
async function publishedDatasetDate(execFileAsync) {
  try {
    const { stdout } = await execFileAsync('gh', [
      'release',
      'view',
      '--json',
      'assets',
      '--jq',
      '.assets[] | select(.name=="manifest.json") | .url'
    ])
    const url = stdout.trim()
    if (!url) return null
    const manifest = JSON.parse(await fetchText(url))
    return manifest.datasetDate ?? null
  } catch {
    return null
  }
}

async function main() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const upstream = parseUpstreamDate(await fetchText(DATA_REQUEST_URL))
  const published = await publishedDatasetDate(execFileAsync)
  const newer = isNewer(upstream, published)

  process.stdout.write(
    [`newer=${newer}`, `upstream_date=${upstream ?? ''}`, `published_date=${published ?? ''}`].join(
      '\n'
    ) + '\n'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-upstream: ${err.message}`)
    process.exit(1)
  })
}

export { parseUpstreamDate, isNewer }
