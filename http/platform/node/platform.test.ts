import { once } from 'node:events'
import { connect as http2Connect, constants as http2Constants } from 'node:http2'
import { connect as netConnect, type Socket } from 'node:net'
import { Readable } from 'node:stream'

import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import { MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $p } from '../../core/routing/picker.js'
import { Args, Controller, Get } from '../../decorators/index.js'
import { createWebApplication, newRouter } from './node.js'

@Controller('/peer')
class Peer {
  @Get('/')
  @Args([$p.address()])
  address(address: string | undefined): object {
    return { address: address ?? null }
  }
}

void [Peer]

type App = ReturnType<typeof createWebApplication>

const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

async function serve(
  routes: ReturnType<typeof newRouter>,
  options: { settings?: object; logger?: { error?: (...args: unknown[]) => void } } = {},
): Promise<{ app: App; origin: string; port: number }> {
  const app = createWebApplication()
    .logger(b => b.use({ ...newNoopLogger(), ...options.logger }))
    .server(() => (options.settings ?? {}) as never)
    .mount(routes)
  apps.push(app)

  const { address } = await app.run({ host: '127.0.0.1', port: 0 })
  return { app, origin: address.origin, port: address.port }
}

/** Writes `text` on a fresh connection and resolves with everything the server sent until it closed or `until` matched. */
function raw(port: number, text: string, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(text))
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      received += chunk
      if (until?.test(received)) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('close', () => resolve(received))
    socket.on('error', reject)
  })
}

function connected(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => resolve(socket))
    socket.on('error', reject)
  })
}

describe('the Node platform', () => {
  it('writes text, bytes and an empty answer under their lengths', async () => {
    const routes = newRouter('/a')
    routes.get('/text').handler(() => 'hi')
    routes.get('/bytes').handler(() => new Uint8Array([1, 2, 3]))
    routes.get('/none').handler(ctx => ctx.status(204).body())
    const { origin } = await serve(routes)

    const text = await fetch(`${origin}/a/text`)
    expect(text.headers.get('content-length')).toBe('2')
    expect(await text.text()).toBe('hi')

    const bytes = await fetch(`${origin}/a/bytes`)
    expect(bytes.headers.get('content-length')).toBe('3')
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([1, 2, 3])

    const none = await fetch(`${origin}/a/none`)
    expect(none.status).toBe(204)
    expect(none.headers.get('content-length')).toBe(null)
    expect(await none.text()).toBe('')
  })

  it('streams a body larger than the socket buffer to its end', async () => {
    const chunk = new Uint8Array(64 * 1024)
    const total = 8 * MiB
    const routes = newRouter('/a')
    routes.get('/big').handler(() => {
      let sent = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= total) {
            controller.close()
            return
          }
          sent += chunk.byteLength
          controller.enqueue(chunk)
        },
      })
    })
    const { origin } = await serve(routes)

    const body = await (await fetch(`${origin}/a/big`)).arrayBuffer()
    expect(body.byteLength).toBe(total)
  })

  it('sends each value of a list-valued header on a line of its own', async () => {
    const routes = newRouter('/a')
    routes.get('/cookies').handler(ctx => {
      ctx.appendHeader('set-cookie', 'a=1').appendHeader('set-cookie', 'b=2')
      return 'ok'
    })
    const { origin } = await serve(routes)

    expect((await fetch(`${origin}/a/cookies`)).headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('answers HEAD on a GET route with its length and no body', async () => {
    const routes = newRouter('/a')
    routes.get('/text').handler(() => 'hi')
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/a/text`, { method: 'HEAD' })
    expect(res.headers.get('content-length')).toBe('2')
    expect(await res.text()).toBe('')
  })

  it('hands ctx.req.raw a Request built from the Node request', async () => {
    const routes = newRouter('/a')
    routes.post('/echo').handler(async ctx => {
      const raw = ctx.req.raw
      return { url: raw.url, method: raw.method, xa: raw.headers.get('x-a'), body: await raw.text() }
    })
    const { origin, port } = await serve(routes)

    const res = await fetch(`${origin}/a/echo?q=1`, { method: 'POST', body: 'ping', headers: { 'x-a': '1' } })
    expect(await res.json()).toEqual({
      url: `http://127.0.0.1:${port}/a/echo?q=1`,
      method: 'POST',
      xa: '1',
      body: 'ping',
    })
  })

  // A middleware that reads only the headers of `raw` leaves the body to whoever reads it next.
  it('takes no body byte when ctx.req.raw is built', async () => {
    const routes = newRouter('/a')
    routes.post('/headers-first').handler(async ctx => {
      void ctx.req.raw.headers
      // Both request classes are a Node `Readable`.
      const incoming = ctx.platform.incoming as Readable
      return { body: await new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>).text() }
    })
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/a/headers-first`, { method: 'POST', body: 'ping' })
    expect(await res.json()).toEqual({ body: 'ping' })
  })

  it('builds ctx.req.raw on localhost when the Host header names no host', async () => {
    const routes = newRouter('/a')
    routes.get('/url').handler(ctx => ctx.req.raw.url)
    const { port } = await serve(routes)

    const answer = await raw(port, 'GET /a/url HTTP/1.1\r\nHost: a@b\r\nConnection: close\r\n\r\n')
    expect(answer.endsWith('http://localhost/a/url')).toBe(true)
  })

  it('is ctx.platform: the Node request and its response', async () => {
    const routes = newRouter('/a')
    routes.get('/platform').handler(ctx => {
      const platform = ctx.platform
      return { name: platform.name, paired: platform.incoming === platform.outgoing.req }
    })
    const { origin } = await serve(routes)

    expect(await (await fetch(`${origin}/a/platform`)).json()).toEqual({ name: 'node', paired: true })
  })

  it('aborts ctx.signal when the client leaves while the handler runs', async () => {
    const started = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<{ aborted: boolean; reason: string }>()
    const routes = newRouter('/a')
    routes.get('/hold').handler(async ctx => {
      started.resolve()
      await once(ctx.signal, 'abort')
      seen.resolve({ aborted: ctx.signal.aborted, reason: (ctx.signal.reason as Error).name })
      return 'late'
    })
    const { port } = await serve(routes)

    const socket = await connected(port)
    socket.write('GET /a/hold HTTP/1.1\r\nHost: x\r\n\r\n')
    await started.promise
    socket.destroy()

    expect(await seen.promise).toEqual({ aborted: true, reason: 'AbortError' })
  })

  it('leaves ctx.signal unaborted for a request answered in full', async () => {
    let signal: AbortSignal | undefined
    const routes = newRouter('/a')
    routes.get('/done').handler(ctx => {
      signal = ctx.signal
      return 'done'
    })
    const { app, origin } = await serve(routes)

    expect(await (await fetch(`${origin}/a/done`)).text()).toBe('done')
    await app.close()

    expect(signal?.aborted).toBe(false)
  })

  it('aborts ctx.signal when an HTTP/2 client cancels its stream while the handler runs', async () => {
    const started = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<boolean>()
    const routes = newRouter('/a')
    routes.get('/hold').handler(async ctx => {
      started.resolve()
      await once(ctx.signal, 'abort')
      seen.resolve(ctx.signal.aborted)
      return 'late'
    })
    const { origin } = await serve(routes, { settings: { http2: true } })

    const session = http2Connect(origin)
    try {
      const stream = session.request({ ':path': '/a/hold' })
      stream.on('error', () => undefined)
      await started.promise
      stream.close(http2Constants.NGHTTP2_CANCEL)

      expect(await seen.promise).toBe(true)
    } finally {
      session.close()
    }
  })

  it('cancels the source of a streamed answer whose client leaves part-way', async () => {
    const cancelled = Promise.withResolvers<void>()
    const error = vi.fn()
    const routes = newRouter('/a')
    routes.get('/endless').handler(
      () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(16 * 1024))
          },
          cancel() {
            cancelled.resolve()
          },
        }),
    )
    const { port } = await serve(routes, { logger: { error } })

    await raw(port, 'GET /a/endless HTTP/1.1\r\nHost: x\r\n\r\n', /\r\n\r\n/)
    await cancelled.promise

    expect(error).not.toHaveBeenCalled()
  })

  it('cuts the response when the source of a streamed answer fails part-way, and logs it', async () => {
    const error = vi.fn()
    const routes = newRouter('/a')
    routes.get('/broken').handler(() => {
      let sent = false
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error('the source failed'))
            return
          }
          sent = true
          controller.enqueue(new TextEncoder().encode('first'))
        },
      })
    })
    const { origin } = await serve(routes, { logger: { error } })

    // Cut before or after its head is flushed: either way the client never reads a whole answer.
    await expect(fetch(`${origin}/a/broken`).then(res => res.text())).rejects.toThrow()

    const sending = error.mock.calls.filter(call => call[1] === 'Cannot send the streamed answer')
    expect(sending.length).toBe(1)
  })

  it('answers 500 rather than resetting the connection when a header value cannot be sent', async () => {
    const error = vi.fn()
    const routes = newRouter('/a')
    routes.get('/bad-header').handler(ctx => {
      ctx.header('x-bad', 'a\r\nb')
      return 'never'
    })
    const { origin } = await serve(routes, { logger: { error } })

    const res = await fetch(`${origin}/a/bad-header`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
    // Logged once, where the answer failed.
    expect(error.mock.calls.map(call => call[1])).toEqual(['Cannot send the answer'])
  })

  // The request never reached its handler, so nothing else tells the operator why it was answered 500.
  it('logs a request it cannot serve at all, and answers 500', async () => {
    const error = vi.fn()
    const routes = newRouter('/a')
    routes.get('/').handler(() => 'never')
    const { app } = await serve(routes, { logger: { error } })

    // A request scope is already open around the call, so the server cannot open the request's own.
    const res = await app.container.requestScopeManager.run(() => app.request('/a'))

    expect(res.status).toBe(500)
    expect(error.mock.calls.map(call => call[1])).toEqual(['Cannot serve the request'])
    expect((error.mock.calls[0]![0] as { err: Error }).err.name).toBe('ErrIllegalScopeState')
  })

  it('answers 100 Continue before reading a body the client holds back', async () => {
    const routes = newRouter('/a')
    routes.post('/echo').handler(async ctx => ctx.req.raw.text())
    const { port } = await serve(routes)

    const socket = await connected(port)
    socket.setEncoding('utf8')
    let received = ''
    const continued = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    socket.on('data', chunk => {
      received += chunk
      if (received.startsWith('HTTP/1.1 100 Continue\r\n\r\n')) {
        continued.resolve()
      }
      if (received.endsWith('ping')) {
        answered.resolve()
      }
    })

    socket.write('POST /a/echo HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n')
    await continued.promise
    socket.write('ping')
    await answered.promise
    socket.destroy()

    expect(received.split('\r\n\r\n')[1]!.startsWith('HTTP/1.1 200 OK')).toBe(true)
  })

  it('fails the body read of a client that aborts its upload', async () => {
    const reading = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<boolean>()
    const routes = newRouter('/a')
    routes.post('/upload').handler(async ctx => {
      reading.resolve()
      try {
        await ctx.req.raw.text()
        failed.resolve(false)
      } catch {
        failed.resolve(true)
      }
      return 'late'
    })
    const { port } = await serve(routes)

    const socket = await connected(port)
    socket.write('POST /a/upload HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\npi')
    await reading.promise
    socket.destroy()

    expect(await failed.promise).toBe(true)
  })

  // A text answer needs nothing from the request scope once Node holds it: ending the scope then keeps a slow reader
  // from holding every object of its request.
  it('ends the request scope of a text answer once Node has it, though the client has not read it', async () => {
    const ended = Promise.withResolvers<void>()
    class Session {}
    const container = new CaffeineIoC()
    container.bind(Session, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(() => ended.resolve()),
    )
    const routes = newRouter('/a')
    routes
      .get('/large')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        return 'x'.repeat(16 * 1024 * 1024)
      })
    const app = createWebApplication({ container })
      .logger(b => b.use(newNoopLogger()))
      .mount(routes)
    apps.push(app)
    const { address } = await app.run({ host: '127.0.0.1', port: 0 })

    const socket = await connected(address.port)
    socket.pause()
    socket.write('GET /a/large HTTP/1.1\r\nHost: x\r\n\r\n')

    await ended.promise
    socket.destroy()
  })

  it('keeps the request scope of a streamed answer until it has been sent', async () => {
    let destroyed = false
    class Session {}
    const container = new CaffeineIoC()
    container.bind(Session, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(() => {
          destroyed = true
        }),
    )
    const routes = newRouter('/a')
    routes
      .get('/streamed')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        let sent = 0
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            // Read after the handler settled: the scope must still be open.
            if (sent === 3) {
              controller.enqueue(new TextEncoder().encode(String(destroyed)))
              controller.close()
              return
            }
            sent++
            controller.enqueue(new TextEncoder().encode('.'))
          },
        })
      })
    const app = createWebApplication({ container })
      .logger(b => b.use(newNoopLogger()))
      .mount(routes)
    apps.push(app)
    const { address } = await app.run({ host: '127.0.0.1', port: 0 })

    expect(await (await fetch(`${address.origin}/a/streamed`)).text()).toBe('...false')
  })

  // The response closed before the answer reached it, so it will not close again: the request must be let go at once,
  // or its scope never ends and close() waits for it forever.
  it('lets close() finish when the client left before a streamed answer', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => (started = resolve))
    let destroyed!: () => void
    const scopeEnded = new Promise<void>(resolve => (destroyed = resolve))
    class Session {}
    const container = new CaffeineIoC()
    container.bind(Session, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(() => destroyed()),
    )
    const routes = newRouter('/a')
    routes
      .get('/late')
      .inject(i => ({ session: i.provide(Session) }))
      .handler(async (ctx, deps) => {
        deps.session.get()
        started()
        if (!ctx.signal.aborted) {
          await once(ctx.signal, 'abort')
        }
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('late'))
            controller.close()
          },
        })
      })
    const app = createWebApplication({ container })
      .logger(b => b.use(newNoopLogger()))
      .mount(routes)
    const { address } = await app.run({ host: '127.0.0.1', port: 0 })
    const socket = netConnect(address.port, '127.0.0.1', () =>
      socket.write('GET /a/late HTTP/1.1\r\nHost: localhost\r\n\r\n'),
    )
    socket.on('error', () => undefined)

    await running
    socket.destroy()
    await scopeEnded

    await expect(app.close()).resolves.toBe(undefined)
  })

  it('answers the address pick with the peer of the socket', async () => {
    const { origin } = await serve(newRouter('/unused'))

    expect(await (await fetch(`${origin}/peer`)).json()).toEqual({ address: '127.0.0.1' })
  })

  it('follows the forwarding headers of a proxy trusted by address, and only of one', async () => {
    const routes = newRouter('/a')
    routes.get('/scheme').handler(ctx => ctx.req.protocol)

    const trusted = createWebApplication()
      .server(() => ({ trustProxy: '127.0.0.1' }))
      .mount(routes)
    const other = createWebApplication()
      .server(() => ({ trustProxy: '10.0.0.0/8' }))
      .mount(routes)
    apps.push(trusted, other)
    await Promise.all([trusted.bootstrap(), other.bootstrap()])

    const headers = { 'x-forwarded-proto': 'https' }
    expect(await (await trusted.request('/a/scheme', { headers })).text()).toBe('https')
    expect(await (await other.request('/a/scheme', { headers })).text()).toBe('http')
  })

  it('refuses at start-up a route the Node application cannot serve yet', async () => {
    const routes = newRouter('/a')
    routes
      .post('/schema')
      .schema({ body: { type: 'object' } } as never)
      .handler(() => 'never')
    const app = createWebApplication().mount(routes)
    apps.push(app)

    await expect(app.bootstrap()).rejects.toThrow('on the Node application')
  })
})
