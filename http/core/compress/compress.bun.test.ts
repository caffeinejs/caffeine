import { gunzipSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DECODE, send, startBunFixture, type BunFixture } from './compress.testkit.js'

/**
 * `compression()` under Bun: the fixture serves the built package with the Bun adapter, and the test reads its answers
 * over a socket, undecoded, with `node:http`.
 */

const PETS = { pets: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `pet number ${i}` })) }

let fixture: BunFixture
let origin: string

beforeAll(async () => {
  fixture = await startBunFixture()
  origin = fixture.origin
}, 30_000)

afterAll(() => fixture?.stop())

describe('compression() under Bun', { timeout: 30_000 }, () => {
  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)('compresses a JSON answer with %s', async coding => {
    const res = await send(origin, '/pets', { headers: { 'accept-encoding': coding } })

    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe(coding)
    expect(res.headers.vary).toBe('Accept-Encoding')
    expect(JSON.parse(DECODE[coding](res.body).toString())).toEqual(PETS)
  })

  it('compresses a streamed answer', async () => {
    const res = await send(origin, '/stream', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(res.body).toString()).toBe('one two three')
  })
})
