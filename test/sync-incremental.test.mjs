import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { run } from '../bin/sync-mirror.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Disk-backed scratch (never /tmp — tmpfs on the dev box), gitignored.
const ROOT = join(__dirname, '..', '.scratch', 'sync-incremental-test')

const TODAY = '2026-07-01'

/** Build a one-page sites_updated row. */
const row = (id, { status = 'active', country = 'Fiji', v = [1, 0], u = '2026-06-30' } = {}) => ({
  site_id: id,
  status,
  country,
  site_major_version: String(v[0]),
  site_minor_version: String(v[1]),
  last_update: u
})

/** Build a /detail response (with or without a boundary). */
const detail = (id, withGeom = true) => ({
  ps_id: id,
  site_name: `Site ${id}`,
  site_major_version: '1',
  site_minor_version: '0',
  ...(withGeom
    ? {
        site_boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0, 0],
              [1, 0, 0],
              [1, 1, 0],
              [0, 0, 0]
            ]
          ]
        }
      }
    : { site_boundary: null })
})

/** A mirror line (download-schema feature) as stored in a shard. */
const mirrorLine = (id, geom = { type: 'Polygon', coordinates: [[[0, 0]]] }) =>
  JSON.stringify({
    type: 'Feature',
    properties: { SITE_ID: id, site_name: `old ${id}` },
    geometry: geom
  })

/** Lay down a fake `mirror` release on disk that the fake gh serves from. */
function seedMirror(remoteDir, { index, state, shards }) {
  fs.mkdirSync(remoteDir, { recursive: true })
  fs.writeFileSync(join(remoteDir, 'mirror-index.json'), JSON.stringify(index) + '\n')
  fs.writeFileSync(join(remoteDir, 'mirror-state.json'), JSON.stringify(state, null, 2) + '\n')
  for (const [name, lines] of Object.entries(shards)) {
    fs.writeFileSync(
      join(remoteDir, name),
      zlib.gzipSync(lines.join('\n') + (lines.length ? '\n' : ''))
    )
  }
}

/**
 * A fake `gh` that implements `release download --pattern` (copy from remoteDir)
 * and `release upload --clobber` (copy into remoteDir), so the mirror round-trips
 * through disk exactly as the real flow does.
 */
function fakeGh(remoteDir) {
  const uploaded = []
  const gh = async (args) => {
    const [, sub] = args
    if (sub === 'download') {
      const dirIdx = args.indexOf('--dir')
      const dest = args[dirIdx + 1]
      fs.mkdirSync(dest, { recursive: true })
      const patterns = args.reduce(
        (acc, a, i) => (a === '--pattern' ? [...acc, args[i + 1]] : acc),
        []
      )
      for (const name of fs.readdirSync(remoteDir)) {
        const match = patterns.some((p) =>
          p.startsWith('*') ? name.endsWith(p.slice(1)) : name === p
        )
        if (match) fs.copyFileSync(join(remoteDir, name), join(dest, name))
      }
      return { stdout: '', stderr: '' }
    }
    if (sub === 'upload') {
      const files = args.slice(args.indexOf('--clobber') + 1)
      for (const f of files) {
        fs.copyFileSync(f, join(remoteDir, f.split('/').pop()))
        uploaded.push(f.split('/').pop())
      }
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  return { gh, uploaded }
}

/** Read back the remote mirror after a run. */
function readRemote(remoteDir) {
  const index = JSON.parse(fs.readFileSync(join(remoteDir, 'mirror-index.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(join(remoteDir, 'mirror-state.json'), 'utf8'))
  const shardIds = {}
  for (const name of fs.readdirSync(remoteDir).filter((n) => n.endsWith('.ndjson.gz'))) {
    const text = zlib
      .gunzipSync(fs.readFileSync(join(remoteDir, name)))
      .toString('utf8')
      .trim()
    shardIds[name] =
      text === '' ? [] : text.split('\n').map((l) => JSON.parse(l).properties.SITE_ID)
  }
  return { index, state, shardIds }
}

/** getJson router: serves sites_updated pages, the census sweep, and detail. */
function router({ windowRows = [], sweepSites = null, details = {} }) {
  return async (url) => {
    if (url.includes('type=sites_updated')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return { sites: page === 1 ? windowRows : [] }
    }
    if (url.includes('type=sites')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return { sites: page === 1 ? (sweepSites ?? []) : [] }
    }
    if (url.includes('/detail/')) {
      const id = decodeURIComponent(new URL(url).searchParams.get('ps_id'))
      return details[id] ?? detail(id, true)
    }
    return { sites: [] }
  }
}

let dir
let remoteDir
let caseN = 0
beforeEach(() => {
  dir = join(ROOT, `t-${caseN++}`)
  remoteDir = join(dir, 'remote')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const baseState = (over = {}) => ({
  schema: 'navigator-download-geojson',
  datasetDate: '2026-06-24',
  downloadDate: '2026-06-02',
  lastSweepDate: '2026-06-24',
  lastFullCensusDate: '2026-06-24',
  siteCount: 0,
  geometryUnavailable: {},
  ...over
})

async function runSync(over = {}, deps = {}) {
  const { gh, uploaded } = fakeGh(remoteDir)
  const argv = ['--work', join(dir, 'work'), '--mirror-tag', 'mirror', ...(over.argv ?? [])]
  await run(argv, {
    gh,
    today: () => TODAY,
    makeClient: () => ({ getJson: over.getJson, stats: { requests: 0 } }),
    ...deps
  })
  return { uploaded }
}

describe('incremental sync — end to end', () => {
  it('quiet week: no rows -> no shard rewrite, index unchanged, baseline advanced', async () => {
    seedMirror(remoteDir, {
      index: { A: { v: [1, 0], u: '2026-06-01' } },
      state: baseState({ siteCount: 1 }),
      shards: { 'updates.ndjson.gz': [mirrorLine('A')] }
    })
    await runSync({ getJson: router({ windowRows: [] }) })
    const { index, state } = readRemote(remoteDir)
    expect(index).toEqual({ A: { v: [1, 0], u: '2026-06-01' } })
    expect(state.lastSweepDate).toBe(TODAY)
  })

  it('new + correction + removal in one window', async () => {
    // A realistic-size mirror (50 sites) so a 3-site delta does not trip the
    // catastrophe tripwire (>50% of the mirror); KNOWN/GONE are the actors.
    const index = { KNOWN: { v: [1, 0], u: '2026-06-01' }, GONE: { v: [1, 0], u: '2026-06-01' } }
    const filler = []
    for (let i = 0; i < 48; i++) {
      index[`F${i}`] = { v: [1, 0], u: '2026-06-01' }
      filler.push(mirrorLine(`F${i}`))
    }
    seedMirror(remoteDir, {
      index,
      state: baseState({ siteCount: 50 }),
      shards: { 'updates.ndjson.gz': [mirrorLine('KNOWN'), mirrorLine('GONE'), ...filler] }
    })
    await runSync({
      getJson: router({
        windowRows: [row('NEW'), row('KNOWN'), row('GONE', { status: 'removed', country: '' })]
      })
    })
    const { index: out, shardIds } = readRemote(remoteDir)
    const ids = Object.values(shardIds).flat()
    expect(out.NEW).toBeDefined()
    expect(out.KNOWN).toBeDefined()
    expect(out.GONE).toBeUndefined()
    expect(ids).toContain('NEW')
    expect(ids).toContain('KNOWN')
    expect(ids).not.toContain('GONE') // removed line dropped
  })

  it('PARKED withheld site, same-version correction in window -> re-fetched, not skipped', async () => {
    // The headline regression: a parked id returning active at the SAME version
    // must be fetched (it may now have a boundary or be a coding correction).
    seedMirror(remoteDir, {
      index: {},
      state: baseState({ siteCount: 0, geometryUnavailable: { PARK: { v: [1, 0] } } }),
      shards: { 'updates.ndjson.gz': [] }
    })
    let fetched = false
    const getJson = async (url) => {
      if (url.includes('/detail/')) {
        fetched = true
        return detail('PARK', true) // now HAS a boundary
      }
      if (url.includes('type=sites_updated')) {
        const page = Number(new URL(url).searchParams.get('page'))
        return { sites: page === 1 ? [row('PARK', { v: [1, 0] })] : [] }
      }
      return { sites: [] }
    }
    await runSync({ getJson })
    expect(fetched).toBe(true)
    const { index, state } = readRemote(remoteDir)
    expect(index.PARK).toBeDefined() // promoted out of geometryUnavailable
    expect(state.geometryUnavailable.PARK).toBeUndefined()
  })

  it('mirrored site reclassified to high-seas -> removed', async () => {
    seedMirror(remoteDir, {
      index: { HS: { v: [1, 0], u: '2026-06-01' } },
      state: baseState({ siteCount: 1 }),
      shards: { 'updates.ndjson.gz': [mirrorLine('HS')] }
    })
    await runSync({
      getJson: router({
        windowRows: [row('HS', { status: 'active', country: 'High Seas / International' })]
      })
    })
    const { index, shardIds } = readRemote(remoteDir)
    expect(index.HS).toBeUndefined()
    expect(Object.values(shardIds).flat()).not.toContain('HS')
  })

  it('mass removal trips assertSaneDelta -> throws, nothing uploaded', async () => {
    const index = {}
    for (let i = 0; i < 300; i++) index[`S${i}`] = { v: [1, 0], u: '2026-06-01' }
    seedMirror(remoteDir, {
      index,
      state: baseState({ siteCount: 300 }),
      shards: { 'updates.ndjson.gz': Object.keys(index).map((id) => mirrorLine(id)) }
    })
    const windowRows = Object.keys(index).map((id) => row(id, { status: 'removed', country: '' }))
    await expect(runSync({ getJson: router({ windowRows }) })).rejects.toThrow('refusing')
  })
})

describe('census path — end to end', () => {
  it('no baseline forces a census that rebuilds + sets both anchors', async () => {
    seedMirror(remoteDir, {
      index: { A: { v: [1, 0], u: '2026-06-01' } },
      state: baseState({ siteCount: 1, lastSweepDate: null, lastFullCensusDate: null }),
      shards: { 'updates.ndjson.gz': [mirrorLine('A')] }
    })
    // census sweep returns A unchanged + a NEW site B
    await runSync({
      getJson: router({ sweepSites: [row('A', { v: [1, 0] }), row('B', { v: [1, 0] })] })
    })
    const { index, state } = readRemote(remoteDir)
    expect(Object.keys(index).sort()).toEqual(['A', 'B'])
    expect(state.lastFullCensusDate).toBe(TODAY)
    expect(state.lastSweepDate).toBe(TODAY)
  })

  it('census: a changed_since-active id absent from the sweep is NOT fetched as changed', async () => {
    // GONE was removed mid-sweep: census omits it (-> diff.removed), but the
    // changed_since window still lists it active. It must not be folded into
    // `changed` (which would fetch a non-existent site).
    // Filler so the single removal stays under assertSaneSweep's 10% census cap.
    const index = { KEEP: { v: [1, 0], u: '2026-06-01' }, GONE: { v: [1, 0], u: '2026-06-01' } }
    const lines = [mirrorLine('KEEP'), mirrorLine('GONE')]
    const sweep = [row('KEEP', { v: [1, 0] })]
    for (let i = 0; i < 20; i++) {
      index[`F${i}`] = { v: [1, 0], u: '2026-06-01' }
      lines.push(mirrorLine(`F${i}`))
      sweep.push(row(`F${i}`, { v: [1, 0] }))
    }
    seedMirror(remoteDir, {
      index,
      state: baseState({ siteCount: 22, lastFullCensusDate: null }), // forces census
      shards: { 'updates.ndjson.gz': lines }
    })
    const fetched = []
    const getJson = async (url) => {
      if (url.includes('type=sites&')) {
        const page = Number(new URL(url).searchParams.get('page'))
        return { sites: page === 1 ? sweep : [] } // GONE absent from the sweep
      }
      if (url.includes('type=sites_updated')) {
        const page = Number(new URL(url).searchParams.get('page'))
        return { sites: page === 1 ? [row('GONE', { v: [1, 0] })] : [] } // window still lists GONE
      }
      if (url.includes('/detail/')) {
        fetched.push(decodeURIComponent(new URL(url).searchParams.get('ps_id')))
        return detail('KEEP', true)
      }
      return { sites: [] }
    }
    await runSync({ getJson })
    expect(fetched).not.toContain('GONE')
    const { index: out } = readRemote(remoteDir)
    expect(out.GONE).toBeUndefined()
    expect(out.KEEP).toBeDefined()
  })

  it('--full forces a census even with a fresh baseline', async () => {
    let sweptCatalog = false
    const getJson = async (url) => {
      if (url.includes('type=sites&')) {
        sweptCatalog = true
        const page = Number(new URL(url).searchParams.get('page'))
        return { sites: page === 1 ? [row('A', { v: [1, 0] })] : [] }
      }
      if (url.includes('type=sites_updated')) return { sites: [] }
      if (url.includes('/detail/')) return detail('A', true)
      return { sites: [] }
    }
    seedMirror(remoteDir, {
      index: { A: { v: [1, 0], u: '2026-06-01' } },
      state: baseState({ siteCount: 1, lastFullCensusDate: TODAY }), // census "just ran"
      shards: { 'updates.ndjson.gz': [mirrorLine('A')] }
    })
    await runSync({ getJson, argv: ['--full', 'true'] })
    expect(sweptCatalog).toBe(true)
  })
})
