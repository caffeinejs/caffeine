import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { Router } from '@caffeinejs/http'
import { compression } from '@caffeinejs/http/compress'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { dist, fixtures, isolated, SCRIPT } from './_headers.js'

/**
 * Static mounts under `compression()`: a variant the build wrote goes out as it is, a file with none is compressed on
 * the way out, and a mount `compression()` does not cover stays identity.
 */

const SCRIPT_URL = '/assets/app-eZr2sdaR.js'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serve(build: () => { bootstrap(): Promise<unknown>; close(): Promise<void> }) {
  const built = build()
  app = built
  await built.bootstrap()
  return built as unknown as { request(path: string, init?: RequestInit): Promise<Response> }
}

describe('a static mount under compression()', () => {
  it('sends the brotli variant the build wrote as it is, with one Content-Encoding and one Vary entry', async () => {
    const built = await serve(() =>
      isolated()
        .with(compression())
        .with(staticFiles(s => s.serve(dist, { anonymous: true }))),
    )

    const res = await built.request(SCRIPT_URL, { headers: { ...SCRIPT, 'accept-encoding': 'br' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('spa bundle')
  })

  // RFC 9110 §12.1: with nothing on disk the client accepts, the mount sends identity for compression() to code.
  it('codes a file with no variant for a client that refuses identity', async () => {
    const built = await serve(() =>
      isolated()
        .with(compression(c => c.threshold(0)))
        .with(staticFiles(s => s.serve(fixtures, { anonymous: true }))),
    )

    const res = await built.request('/hello.txt', { headers: { 'accept-encoding': 'gzip, identity;q=0' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe('hello static world\n')
  })

  it('compresses a file the build wrote no variant for', async () => {
    const built = await serve(() =>
      isolated()
        .with(compression(c => c.threshold(0)))
        .with(staticFiles(s => s.serve(fixtures, { anonymous: true }))),
    )

    const res = await built.request('/hello.txt', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe('hello static world\n')
  })

  // A mount is the server's own: to keep its files identity, cover only the routers that should compress.
  it('leaves a mount alone when compression() covers another router only', async () => {
    const api = new Router('/api').with(compression(c => c.threshold(0)))
    api.get('/').handler(() => 'compressed api answer')
    const built = await serve(() =>
      isolated()
        .with(staticFiles(s => s.serve(fixtures, { anonymous: true })))
        .mount(api),
    )

    const file = await built.request('/hello.txt', { headers: { 'accept-encoding': 'gzip' } })
    const answer = await built.request('/api', { headers: { 'accept-encoding': 'gzip' } })

    expect(file.headers.get('content-encoding')).toBe(null)
    expect(await file.text()).toBe('hello static world\n')
    expect(answer.headers.get('content-encoding')).toBe('gzip')
  })

  it('answers a range of a static file with identity bytes', async () => {
    const built = await serve(() =>
      isolated()
        .with(compression(c => c.threshold(0)))
        .with(staticFiles(s => s.serve(fixtures, { anonymous: true }))),
    )

    const res = await built.request('/hello.txt', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-4' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-encoding')).toBe(null)
    expect(await res.text()).toBe('hello')
  })
})
