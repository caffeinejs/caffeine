import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { constants, createZstdCompress, gzipSync } from 'node:zlib'

import { KiB, MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { decompression, type DecompressionBuilder } from './decompression.js'

/**
 * What the HTTP and coding RFCs ask of a server that decodes request bodies, one `describe` per section, each `it`
 * naming the requirement it checks.
 */

type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

async function serve(
  configure: ((d: DecompressionBuilder) => DecompressionBuilder) | undefined,
  ...routers: AnyRouter[]
) {
  const built = createWebApplication()
    .with(decompression(configure))
    .mount(...routers)
  apps.push(built)
  await built.bootstrap()
  return built
}

describe('RFC 9110 §8.4 and §15.5.16 a coded request body', () => {
  const echo = () =>
    new Router('/echo')
      .post('/')
      .bodyLimit(1 * KiB)
      .handler(ctx => ({ size: JSON.stringify(ctx.req.body()).length }))

  function post(coding: string, body: Uint8Array): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': coding }, body }
  }

  it('§15.5.16: answers a coding it does not decode with 415 and an Accept-Encoding of what it does', async () => {
    const app = await serve(d => d.encodings('gzip', 'br'), echo())
    const res = await app.request('/echo', post('zstd', new Uint8Array([1, 2, 3])))

    expect(res.status).toBe(415)
    expect(res.headers.get('accept-encoding')).toBe('gzip, br')
  })

  it('RFC 1952 §2.2: decodes a gzip body of several members as their contents joined', async () => {
    const app = await serve(undefined, echo())
    const members = Buffer.concat([gzipSync('{"a":'), gzipSync('"bc"}')])
    const res = await app.request('/echo', post('gzip', members))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: '{"a":"bc"}'.length })
  })

  it('§15.5.14: holds the decoded bytes to the limit: exactly the limit passes, one byte more is a 413', async () => {
    const app = await serve(undefined, echo())
    const exact = JSON.stringify({ s: 'x'.repeat(1 * KiB - 8) })
    const over = JSON.stringify({ s: 'x'.repeat(1 * KiB - 7) })

    expect(Buffer.byteLength(exact)).toBe(1 * KiB)
    expect((await app.request('/echo', post('gzip', gzipSync(exact)))).status).toBe(200)
    expect((await app.request('/echo', post('gzip', gzipSync(over)))).status).toBe(413)
  })
})

describe('RFC 9659 §3: a zstd window up to 8 MiB', () => {
  // RFC 8878 §3.1.1.1.2: the window a decoder must hold, from the Window_Descriptor of a frame that is not single
  // segment.
  function windowSize(frame: Buffer): number {
    const descriptor = frame[5]!
    const base = 2 ** (10 + (descriptor >> 3))
    return base + (base / 8) * (descriptor & 7)
  }

  it('decodes a small body streamed in a frame that declares an 8 MiB window, under any body limit', async () => {
    const app = await serve(
      undefined,
      new Router('/echo')
        .post('/')
        .bodyLimit(1 * KiB)
        .handler(ctx => ctx.req.body()),
    )
    const coder = createZstdCompress({ params: { [constants.ZSTD_c_windowLog]: 23 } })
    const frame = await buffer(Readable.from([Buffer.from('{"a":1}')]).pipe(coder))

    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: frame,
    })

    // Stream-coded with no size: not single segment, so its window is declared rather than its content size.
    expect((frame[4]! >> 5) & 1).toBe(0)
    expect(windowSize(frame)).toBe(8 * MiB)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: 1 })
  })
})
