import { gzipSync } from 'node:zlib'

import { MiB } from '@caffeinejs/std/bytes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { send, startBunFixture, type BunFixture } from './compress.testkit.js'

/** `decompression()` under Bun: the fixture serves the built package with the Bun adapter. */

let fixture: BunFixture
let origin: string

beforeAll(async () => {
  fixture = await startBunFixture()
  origin = fixture.origin
}, 30_000)

afterAll(() => fixture?.stop())

describe('decompression() under Bun', { timeout: 30_000 }, () => {
  it('decodes a gzip request body', async () => {
    const res = await send(origin, '/echo', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync('{"a":1}'),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ value: { a: 1 } })
  })

  it('answers a body that inflates past the limit with a 413', async () => {
    const res = await send(origin, '/echo', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(new Uint8Array(2 * MiB)),
    })

    expect(res.status).toBe(413)
  })

  it('decodes a body on a route whose limit is above the largest buffer Bun makes', async () => {
    const res = await send(origin, '/huge', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync('{"a":1}'),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ value: { a: 1 } })
  })
})
