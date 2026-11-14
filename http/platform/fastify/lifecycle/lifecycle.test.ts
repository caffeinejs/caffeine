import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../../../adapter.js'
import { HTTPPlugin, type RouteDefinition, Router } from '../../../index.js'
import { createWebApplication } from '../index.js'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

function plugin(fn: (context: HTTPSetupContext) => void): () => HTTPPlugin {
  return () =>
    new (class extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        fn(context)
      }
    })()
}

describe('the lifecycle on Fastify', () => {
  // The engine's payload is a web stream: a Fastify reply streamed from a Node stream is handed over as one, and a web
  // stream an onSend hook returns goes out.
  it('hands onSend a web stream for a streamed reply and sends the one it returns', async () => {
    let handed: unknown
    const a = createWebApplication()
      .hook('onSend', (_ctx, payload) => {
        handed = payload
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('replaced'))
            controller.close()
          },
        })
      })
      .mount(new Router('/stream').get('/').handler(() => Readable.from(['a', 'b'])))
    app = a
    await a.bootstrap()

    const res = await a.request('/stream')

    expect(await res.text()).toBe('replaced')
    expect(handed).toBeInstanceOf(ReadableStream)
  })

  // A hook that keeps the payload keeps what Fastify was handed, a `Response` with its status and headers included.
  it('sends a Response as it was when every onSend hook keeps the payload', async () => {
    const a = createWebApplication()
      .serverCallback((_ctx, instance) => {
        instance.get('/gone', (_req, reply) =>
          reply.send(new Response('gone', { status: 410, headers: { 'x-a': 'b' } })),
        )
      })
      .hook('onSend', ctx => void ctx.header('x-hook', '1'))
    app = a
    await a.bootstrap()

    const res = await a.request('/gone')

    expect(res.status).toBe(410)
    expect(res.headers.get('x-a')).toBe('b')
    expect(await res.text()).toBe('gone')
  })

  // Handing a stream to an onSend hook must not leave it half-read: kept, it still goes out whole.
  it('sends a streamed Node reply larger than its buffer whole when every onSend hook keeps it', async () => {
    const chunk = 'x'.repeat(1024)
    const a = createWebApplication()
      .hook('onSend', ctx => void ctx.header('x-seen', '1'))
      .mount(new Router('/big').get('/').handler(() => Readable.from(Array.from({ length: 200 }, () => chunk))))
    app = a
    await a.bootstrap()

    const res = await a.request('/big')

    expect((await res.text()).length).toBe(200 * 1024)
  })

  // A route registered on Fastify directly is no route Caffeine compiled: onRoute never sees it.
  it('hands onRoute only the routes Caffeine compiled', async () => {
    const seen: RouteDefinition[] = []
    const a = createWebApplication()
      .serverCallback((_ctx, instance) => {
        instance.get('/raw', () => 'raw')
      })
      .hook('onRoute', route => void seen.push(route))
      .mount(new Router('/compiled').get('/').handler(() => 'compiled'))
    app = a
    await a.bootstrap()

    expect(await (await a.request('/raw')).text()).toBe('raw')
    expect(seen.map(route => route.url)).toEqual(['/compiled'])
  })

  // Fastify installs a router's plugins once per group; a server hook still runs once per server.
  it("runs a router plugin's onReady once for a router with two groups", async () => {
    let ready = 0
    const a = createWebApplication().mount(
      new Router('/r')
        .with(plugin(({ app: ops }) => ops.hook('onReady', () => void (ready += 1))))
        .get('/a', () => 'a')
        .group('/g', g => g.get('/b', () => 'b')),
    )
    app = a
    await a.bootstrap()

    expect(await (await a.request('/r/g/b')).text()).toBe('b')
    expect(ready).toBe(1)
  })
})
