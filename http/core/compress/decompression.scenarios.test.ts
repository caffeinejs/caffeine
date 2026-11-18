import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib'

import { KiB, MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { node } from '../../platform/node/node.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { send } from './compress.testkit.js'
import { decompression } from './decompression.js'

/** `decompression()` in the situations an application meets it, over a socket under `node()`: uploads. */

type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

async function listen(app: ReturnType<typeof createWebApplication>, ...routers: AnyRouter[]): Promise<string> {
  const built = app.mount(...routers)
  apps.push(built)
  const { address } = await built.run({ host: '127.0.0.1', port: 0 })
  return `http://127.0.0.1:${address!.port}`
}

const app = () => createWebApplication({ adapter: node() })

describe('uploads under decompression()', () => {
  const echo = () => new Router('/upload').post('/').handler(ctx => ({ received: ctx.req.body() }))

  it('reads a gzip upload with a Content-Length and a chunked br one alike', async () => {
    const origin = await listen(app().with(decompression()), echo())
    const json = JSON.stringify({ name: 'Rex' })

    const sized = await send(origin, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(json),
    })
    const coded = brotliCompressSync(json)
    const chunked = await send(origin, '/upload', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: [coded.subarray(0, 3), coded.subarray(3)],
    })

    expect(sized.status).toBe(200)
    expect(JSON.parse(sized.body.toString())).toEqual({ received: { name: 'Rex' } })
    expect(chunked.status).toBe(200)
    expect(JSON.parse(chunked.body.toString())).toEqual({ received: { name: 'Rex' } })
  })

  it('refuses a decompression bomb with a 413 and keeps serving', async () => {
    const origin = await listen(app().with(decompression()), echo())
    const bomb = zstdCompressSync(new Uint8Array(64 * MiB))

    const refused = await send(origin, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: bomb,
    })
    const next = await send(origin, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}'),
    })

    expect(bomb.byteLength).toBeLessThan(64 * KiB)
    expect(refused.status).toBe(413)
    expect(next.status).toBe(200)
    expect(JSON.parse(next.body.toString())).toEqual({ received: { ok: true } })
  })

  it('answers a corrupt upload with a 400', async () => {
    const origin = await listen(app().with(decompression()), echo())

    const res = await send(origin, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: Buffer.from('definitely not zstd'),
    })

    expect(res.status).toBe(400)
  })
})
