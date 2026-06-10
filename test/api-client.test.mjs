import { describe, it, expect } from 'vitest'
import { createApiClient, API_BASE } from '../bin/lib/api-client.mjs'

/** Fake clock + fetch harness; sleeps advance the clock instantly. */
function harness(responses) {
  let clock = 0
  const calls = []
  const sleeps = []
  const client = createApiClient({
    fetchImpl: async (url) => {
      calls.push({ url, at: clock })
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock
  })
  return { client, calls, sleeps, tick: (ms) => (clock += ms) }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const status = (code) => ({ ok: false, status: code, json: async () => ({}) })

describe('createApiClient', () => {
  it('spaces consecutive requests by the pacing interval (5 req/10 s limit)', async () => {
    const { client, calls } = harness([ok({ a: 1 }), ok({ b: 2 }), ok({ c: 3 })])
    await client.getJson(`${API_BASE}/x`)
    await client.getJson(`${API_BASE}/y`)
    await client.getJson(`${API_BASE}/z`)
    expect(calls.map((c) => c.at)).toEqual([0, 2500, 5000])
  })

  it('serializes concurrent callers through the pacing chain', async () => {
    const { client, calls } = harness([ok(1), ok(2), ok(3)])
    const results = await Promise.all([
      client.getJson('u1'),
      client.getJson('u2'),
      client.getJson('u3')
    ])
    expect(results).toEqual([1, 2, 3])
    expect(calls.map((c) => c.at)).toEqual([0, 2500, 5000])
  })

  it('retries 5xx with exponential backoff and returns the eventual body', async () => {
    const { client, sleeps } = harness([status(502), status(503), ok({ fine: true })])
    const body = await client.getJson('url')
    expect(body).toEqual({ fine: true })
    expect(sleeps).toContain(5000)
    expect(sleeps).toContain(10000)
  })

  it('pauses long on 429 before retrying', async () => {
    const { client, sleeps } = harness([status(429), ok('ok')])
    await expect(client.getJson('url')).resolves.toBe('ok')
    expect(sleeps).toContain(30000)
  })

  it('gives up after the retry budget and propagates the failure', async () => {
    const { client } = harness([status(500), status(500), status(500), status(500), status(500)])
    await expect(client.getJson('url')).rejects.toThrow('HTTP 500')
  })

  it('does not retry client errors like 404', async () => {
    const { client, calls } = harness([status(404)])
    await expect(client.getJson('url')).rejects.toThrow('HTTP 404')
    expect(calls).toHaveLength(1)
  })

  it('a failed request does not wedge the chain for the next caller', async () => {
    const { client } = harness([status(400), ok('after')])
    await expect(client.getJson('bad')).rejects.toThrow('HTTP 400')
    await expect(client.getJson('good')).resolves.toBe('after')
  })
})
