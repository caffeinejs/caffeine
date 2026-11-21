import { createWebApplication, Router } from '@caffeinejs/http'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'

import { sendFile as sendFromMixed, staticFiles as mixedFiles } from '../index.js'
import { verifyStaticAssets, type StaticAssetSource } from '../web/index.js'
import { sendFile, staticFiles } from './index.js'

const bytes = Uint8Array.of(97, 98, 99)
const entry = {
  size: 3,
  type: 'text/plain',
  hash: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
  lastModified: '2026-11-18T00:00:00Z',
  variants: {},
}

async function fixture(key: string) {
  const open = vi.fn<StaticAssetSource['open']>(async requested => {
    if (requested !== key) {
      throw new Error('Unexpected storage key')
    }
    return new Blob([bytes]).stream()
  })
  const manifest = JSON.stringify({ version: 1, files: { [key]: entry } })
  const assets = await verifyStaticAssets({ readManifest: async () => new Blob([manifest]).stream(), open })
  open.mockClear()
  return { assets, open }
}

describe('staticFiles with verified sources', () => {
  const apps: { close(): Promise<void> }[] = []

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      await app.close()
    }
  })

  it('opens the provider of each file on a shared wildcard and selects exact keys in sendFile', async () => {
    const a = await fixture('assets/first.txt')
    const b = await fixture('assets/second%.txt')
    const app = createWebApplication({ logger: false })
      .with(staticFiles(s => s.serve(a.assets).serve(b.assets)))
      .mount(
        new Router()
          .get('/first', ctx => sendFile(ctx, 'assets/first.txt'))
          .get('/second', ctx => sendFile(ctx, 'assets/second%.txt', b.assets)),
      )
    apps.push(app)
    await app.bootstrap()

    const head = await app.fetch(new Request('http://localhost/assets/second%25.txt', { method: 'HEAD' }))
    expect(head.headers.get('content-length')).toBe('3')
    expect(head.body).toBe(null)
    expect(b.open).not.toHaveBeenCalled()
    for (const path of ['/assets/first.txt', '/assets/second%25.txt', '/first', '/second']) {
      const response = await app.fetch(new Request('http://localhost' + path))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('abc')
    }
    expect(a.open).toHaveBeenCalledTimes(2)
    expect(b.open).toHaveBeenCalledTimes(2)
  })

  it('uses the opener of each file when a disk mount and a source share a wildcard', async () => {
    const { assets, open } = await fixture('assets/provider.txt')
    const { spa } = inject('fixtures')
    const app = createWebApplication({ logger: false })
      .with(mixedFiles(s => s.serve(assets).serve(spa, { index: false })))
      .mount(new Router().get('/fallback', ctx => sendFromMixed(ctx, 'assets/provider.txt')))
    apps.push(app)
    await app.bootstrap()

    const disk = await app.fetch(new Request('http://localhost/assets/app-eZr2sdaR.js'))
    expect(disk.status).toBe(200)
    expect((await disk.bytes()).byteLength).toBeGreaterThan(3)
    expect(open).not.toHaveBeenCalled()

    const source = await app.fetch(new Request('http://localhost/fallback'))
    expect(await source.text()).toBe('abc')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('lets a disk response hook change a handler-set status and keep the file', async () => {
    const { spa } = inject('fixtures')
    const app = createWebApplication({ logger: false })
      .with(mixedFiles(s => s.serve(spa, { unrouted: ['index.html'] })))
      .mount(
        new Router().get('/shell', ctx => {
          ctx.status(204)
          return sendFromMixed(ctx, 'index.html')
        }),
      )
      .hook('onSend', ctx => {
        ctx.status(200)
      })
    apps.push(app)
    await app.bootstrap()

    const response = await app.fetch(new Request('http://localhost/shell'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('<html')
  })

  it('preserves a no-store directive without treating a quoted extension as one', async () => {
    const { assets } = await fixture('file.txt')
    const app = createWebApplication({ logger: false })
      .with(staticFiles(s => s.serve(assets, { unrouted: ['**'] })))
      .mount(
        new Router()
          .get('/private', ctx => {
            ctx.header('cache-control', 'private, no-store')
            return sendFile(ctx, 'file.txt', assets)
          })
          .get('/quoted', ctx => {
            ctx.header('cache-control', 'public, ext="a, no-store, b"')
            return sendFile(ctx, 'file.txt', assets)
          }),
      )
    apps.push(app)
    await app.bootstrap()

    for (const [path, cache] of [
      ['private', 'private, no-store'],
      ['quoted', 'private, no-cache'],
    ]) {
      const response = await app.fetch(new Request('http://localhost/' + path))
      expect(await response.text()).toBe('abc')
      expect(response.headers.get('cache-control')).toBe(cache)
    }
  })

  it('closes only the abandoned request while another request uses the same handle', async () => {
    const { assets, open } = await fixture('file.txt')
    const cancelled = vi.fn()
    const reading = Promise.withResolvers<void>()
    open.mockResolvedValueOnce(
      new ReadableStream<Uint8Array>(
        {
          pull: () => reading.resolve(),
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      ),
    )

    const app = createWebApplication({ logger: false }).with(staticFiles(s => s.serve(assets)))
    apps.push(app)
    await app.bootstrap()

    const abandoned = await app.fetch(new Request('http://localhost/file.txt'))
    const reader = abandoned.body!.getReader()
    const pending = reader.read()
    await reading.promise

    const other = await app.fetch(new Request('http://localhost/file.txt'))
    expect(await other.text()).toBe('abc')
    expect(cancelled).not.toHaveBeenCalled()

    await reader.cancel()
    await pending
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('isolates mount header callbacks from the verified release and another server', async () => {
    const { assets } = await fixture('file.txt')
    const first = createWebApplication({ logger: false }).with(
      staticFiles(s =>
        s.serve(assets, {
          headers(file) {
            Reflect.set(file, 'type', 'application/x-changed')
            Reflect.set(file.variants, 'gzip', {})
            return { 'x-mount': 'first' }
          },
        }),
      ),
    )
    const second = createWebApplication({ logger: false }).with(
      staticFiles(s =>
        s.serve(assets, {
          headers: () => ({ 'x-mount': 'second' }),
        }),
      ),
    )
    apps.push(first, second)
    await first.bootstrap()
    await second.bootstrap()

    const request = new Request('http://localhost/file.txt')
    const a = await first.fetch(request)
    const b = await second.fetch(request)
    const c = await assets.respond(request, 'file.txt')
    for (const [response, label] of [
      [a, 'first'],
      [b, 'second'],
      [c, null],
    ] as const) {
      expect(response.headers.get('x-mount')).toBe(label)
      expect(response.headers.get('content-type')).toBe('text/plain')
      expect(await response.text()).toBe('abc')
    }
  })

  it('matches brackets in a manifest key literally in the unrouted and immutable options', async () => {
    const key = 'chunk[1].txt'
    const { assets, open } = await fixture(key)
    const app = createWebApplication({ logger: false })
      .with(staticFiles(s => s.serve(assets, { unrouted: [key], immutable: [key] })))
      .mount(new Router().get('/chunk', ctx => sendFile(ctx, key, assets)))
    apps.push(app)
    await app.bootstrap()

    const missing = await app.fetch(new Request('http://localhost/chunk[1].txt'))
    expect(missing.status).toBe(404)
    expect(open).not.toHaveBeenCalled()
    const reply = await app.fetch(new Request('http://localhost/chunk'))
    expect(reply.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await reply.text()).toBe('abc')
  })

  it('rejects duplicate mounts for a verified handle before serving', async () => {
    const { assets, open } = await fixture('file.txt')
    const app = createWebApplication({ logger: false }).with(
      staticFiles(s => s.serve(assets).serve(assets, { prefix: '/other' })),
    )
    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_CONFIGURATION' })
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['replace', 'lock and replace', 'throw', 'transform'])(
    'releases provider reads when an onSend hook can %s',
    async mode => {
      const { assets, open } = await fixture('file.txt')
      const cancelled = vi.fn()
      const completed = Promise.withResolvers<void>()
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      )
      const abandoned = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 })
      open.mockResolvedValueOnce(mode === 'transform' ? body : abandoned)

      const app = createWebApplication({ logger: false })
        .with(staticFiles(s => s.serve(assets)))
        .hook('onSend', (_ctx, payload) => {
          if (mode === 'throw') {
            throw new Error('Hook failed')
          }
          if (mode === 'lock and replace') {
            ;(payload as ReadableStream).getReader()
          }
          return mode === 'transform'
            ? (payload as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
            : 'replacement'
        })
        .hook('onResponse', () => completed.resolve())
      apps.push(app)
      await app.bootstrap()

      const answer = await app.fetch(new Request('http://localhost/file.txt'))
      expect(answer.status).toBe(mode === 'throw' ? 500 : 200)
      const text = await answer.text()
      if (mode !== 'throw') {
        expect(text).toBe(mode === 'transform' ? 'abc' : 'replacement')
      }
      await completed.promise
      expect(open).toHaveBeenCalledTimes(1)
      expect(cancelled).toHaveBeenCalledTimes(mode === 'transform' ? 0 : 1)
      expect(body.locked || abandoned.locked).toBe(false)
    },
  )
})
