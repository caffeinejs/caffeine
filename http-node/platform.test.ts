import assert from 'node:assert'
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect as http2Connect, constants as http2Constants } from 'node:http2'
import { connect as netConnect, type Socket } from 'node:net'
import { Readable } from 'node:stream'

import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import {
  $p,
  type ActionResult,
  type AnyRouter,
  Args,
  bodyAsStream,
  Catch,
  Controller,
  createWebApplication,
  ErrHTTPContentTooLarge,
  type ErrorHandler,
  Get,
  type IContext,
  type Next,
  Router,
  type WebApplication,
} from '@caffeinejs/http'
import { Byte, MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { node, type NodeAdapter } from './node.js'

@Controller('/peer')
class Peer {
  @Get('/')
  @Args([$p.address()])
  address(address: string | undefined): object {
    return { address: address ?? null }
  }
}

void [Peer]

type App = WebApplication<never, never, unknown, NodeAdapter>

const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

async function serve(
  routes: AnyRouter,
  options: { settings?: object; logger?: { error?: (...args: unknown[]) => void } } = {},
): Promise<{ app: App; origin: string; port: number }> {
  const app = createWebApplication({ adapter: node() })
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

// What `socket` sends from now on, once it matches `until`.
function receive(socket: Socket, until: RegExp): Promise<string> {
  return new Promise(resolve => {
    let received = ''
    const onData = (chunk: Buffer | string): void => {
      received += String(chunk)
      if (until.test(received)) {
        socket.off('data', onData)
        resolve(received)
      }
    }
    socket.on('data', onData)
  })
}

@Catch(ErrHTTPContentTooLarge)
class TooLargeAsBadRequest implements ErrorHandler<ErrHTTPContentTooLarge> {
  handle(ctx: IContext): ActionResult {
    ctx.status(400)
    return 'too large'
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Dropped.
  }
}

describe('the Node platform', () => {
  it('writes text, bytes and an empty answer under their lengths', async () => {
    const routes = new Router('/a')
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
    const routes = new Router('/a')
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
    const routes = new Router('/a')
    routes.get('/cookies').handler(ctx => {
      ctx.appendHeader('set-cookie', 'a=1').appendHeader('set-cookie', 'b=2')
      return 'ok'
    })
    const { origin } = await serve(routes)

    expect((await fetch(`${origin}/a/cookies`)).headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('sends each cookie set on a Set-Cookie line of its own', async () => {
    const routes = new Router('/a')
    routes.get('/set').handler(ctx => {
      ctx.cookie('a', 'b')
      ctx.cookie('c', 'd')
      return 'ok'
    })
    const { origin } = await serve(routes)

    expect((await fetch(`${origin}/a/set`)).headers.getSetCookie()).toEqual([
      'a=b; Path=/; SameSite=Lax',
      'c=d; Path=/; SameSite=Lax',
    ])
  })

  it('answers HEAD on a GET route with its length and no body', async () => {
    const routes = new Router('/a')
    routes.get('/text').handler(() => 'hi')
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/a/text`, { method: 'HEAD' })
    expect(res.headers.get('content-length')).toBe('2')
    expect(await res.text()).toBe('')
  })

  it('hands ctx.req.raw a Request built from the Node request', async () => {
    const routes = new Router('/a')
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

  // A hook that reads only the headers of `raw` leaves the body to the route, which reads it next.
  it('takes no body byte when ctx.req.raw is built', async () => {
    const routes = new Router('/a')
    routes
      .post('/headers-first')
      .hook('onRequest', ctx => void ctx.req.raw.headers)
      .handler(ctx => ({ body: ctx.req.body() }))
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/a/headers-first`, { method: 'POST', body: 'ping' })
    expect(await res.json()).toEqual({ body: 'ping' })
  })

  it('builds ctx.req.raw on localhost when the Host header names no host', async () => {
    const routes = new Router('/a')
    routes.get('/url').handler(ctx => ctx.req.raw.url)
    const { port } = await serve(routes)

    const answer = await raw(port, 'GET /a/url HTTP/1.1\r\nHost: a@b\r\nConnection: close\r\n\r\n')
    expect(answer.endsWith('http://localhost/a/url')).toBe(true)
  })

  it('is ctx.platform: the Node request and its response', async () => {
    const routes = new Router('/a')
    routes.get('/platform').handler(ctx => {
      assert(ctx.platform.name === 'node')
      const platform = ctx.platform
      return { name: platform.name, paired: platform.incoming === platform.outgoing.req }
    })
    const { origin } = await serve(routes)

    expect(await (await fetch(`${origin}/a/platform`)).json()).toEqual({ name: 'node', paired: true })
  })

  it('aborts ctx.signal when the client leaves while the handler runs', async () => {
    const started = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<{ aborted: boolean; reason: string }>()
    const routes = new Router('/a')
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
    const routes = new Router('/a')
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
    const routes = new Router('/a')
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
    const routes = new Router('/a')
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
    const routes = new Router('/a')
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

  // A Node stream goes to the response as the handler returned it, with what a web stream's answer guarantees.
  it('pipes a Node stream answer to its end, text chunks included', async () => {
    const chunk = Buffer.alloc(64 * 1024)
    const total = 8 * MiB
    const routes = new Router('/a')
    routes.get('/big').handler(() =>
      Readable.from(
        (function* () {
          for (let sent = 0; sent < total; sent += chunk.byteLength) {
            yield chunk
          }
        })(),
      ),
    )
    routes.get('/text').handler(() => Readable.from(['a', 'b']))
    const { origin } = await serve(routes)

    const big = await fetch(`${origin}/a/big`)
    expect(big.headers.get('content-type')).toBe('application/octet-stream')
    expect((await big.arrayBuffer()).byteLength).toBe(total)
    expect(await (await fetch(`${origin}/a/text`)).text()).toBe('ab')
  })

  it('destroys the Node stream of an answer whose client leaves part-way', async () => {
    const closed = Promise.withResolvers<void>()
    const error = vi.fn()
    const routes = new Router('/a')
    routes.get('/endless').handler(() => {
      const stream = new Readable({
        read() {
          this.push(Buffer.alloc(16 * 1024))
        },
      })
      stream.on('close', () => closed.resolve())
      return stream
    })
    const { port } = await serve(routes, { logger: { error } })

    await raw(port, 'GET /a/endless HTTP/1.1\r\nHost: x\r\n\r\n', /\r\n\r\n/)
    await closed.promise

    expect(error).not.toHaveBeenCalled()
  })

  it('cuts the response when a Node stream answer fails part-way, and logs it', async () => {
    const error = vi.fn()
    const routes = new Router('/a')
    routes.get('/broken').handler(() => {
      let sent = false
      return new Readable({
        read() {
          if (sent) {
            this.destroy(new Error('the source failed'))
            return
          }
          sent = true
          this.push('first')
        },
      })
    })
    const { origin } = await serve(routes, { logger: { error } })

    // Cut before or after its head is flushed: either way the client never reads a whole answer.
    await expect(fetch(`${origin}/a/broken`).then(res => res.text())).rejects.toThrow()

    const sending = error.mock.calls.filter(call => call[1] === 'Cannot send the streamed answer')
    expect(sending.length).toBe(1)
  })

  // Nothing reads a HEAD answer's body, so nothing would close its source.
  it('destroys the Node stream of a HEAD answer, which sends no body', async () => {
    const closed = Promise.withResolvers<void>()
    const routes = new Router('/a')
    routes.get('/file').handler(() => {
      const stream = Readable.from(['body'])
      stream.on('close', () => closed.resolve())
      return stream
    })
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/a/file`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    await closed.promise
  })

  // A hook is written against web bytes: a Node stream reaches it as one.
  it('hands an onSend hook a Node stream answer as web bytes', async () => {
    const seen: boolean[] = []
    const routes = new Router('/a')
    routes.hook('onSend', (_ctx, payload) => {
      seen.push(payload instanceof ReadableStream)
    })
    routes.get('/text').handler(() => Readable.from(['a', 'b']))
    const { origin } = await serve(routes)

    expect(await (await fetch(`${origin}/a/text`)).text()).toBe('ab')
    expect(seen).toEqual([true])
  })

  it('answers 500 rather than resetting the connection when a header value cannot be sent', async () => {
    const error = vi.fn()
    const routes = new Router('/a')
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
    const routes = new Router('/a')
    routes.get('/').handler(() => 'never')
    const { app } = await serve(routes, { logger: { error } })

    // A request scope is already open around the call, so the server cannot open the request's own.
    const res = await app.container.requestScopeManager.run(() => app.request('/a'))

    expect(res.status).toBe(500)
    expect(error.mock.calls.map(call => call[1])).toEqual(['Cannot serve the request'])
    expect((error.mock.calls[0]![0] as { err: Error }).err.name).toBe('ErrIllegalScopeState')
  })

  it('answers 100 Continue before reading a body the client holds back', async () => {
    const routes = new Router('/a')
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

    socket.write(
      'POST /a/echo HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\n',
    )
    await continued.promise
    socket.write('ping')
    await answered.promise
    socket.destroy()

    expect(received.split('\r\n\r\n')[1]!.startsWith('HTTP/1.1 200 OK')).toBe(true)
  })

  // Read by the handler: a route reading its body with @BodyAsStream.
  it('fails the body read of a client that aborts its upload', async () => {
    const reading = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<boolean>()
    const routes = new Router('/a')
    routes
      .post('/upload')
      .extend(bodyAsStream())
      .handler(async ctx => {
        reading.resolve()
        try {
          await new Response(ctx.req.body() as ReadableStream<Uint8Array>).text()
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
    const routes = new Router('/a')
    routes
      .get('/large')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        return 'x'.repeat(16 * 1024 * 1024)
      })
    const app = createWebApplication({ adapter: node(), container })
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
    const routes = new Router('/a')
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
    const app = createWebApplication({ adapter: node(), container })
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
    const routes = new Router('/a')
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
    const app = createWebApplication({ adapter: node(), container })
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
    const { origin } = await serve(new Router('/unused'))

    expect(await (await fetch(`${origin}/peer`)).json()).toEqual({ address: '127.0.0.1' })
  })

  it('follows the forwarding headers of a proxy trusted by address, and only of one', async () => {
    const routes = new Router('/a')
    routes.get('/scheme').handler(ctx => ctx.req.protocol)

    const trusted = createWebApplication({ adapter: node() })
      .server(() => ({ trustProxy: '127.0.0.1' }))
      .mount(routes)
    const other = createWebApplication({ adapter: node() })
      .server(() => ({ trustProxy: '10.0.0.0/8' }))
      .mount(routes)
    apps.push(trusted, other)
    await Promise.all([trusted.bootstrap(), other.bootstrap()])

    const headers = { 'x-forwarded-proto': 'https' }
    expect(await (await trusted.request('/a/scheme', { headers })).text()).toBe('https')
    expect(await (await other.request('/a/scheme', { headers })).text()).toBe('http')
  })

  it('refuses at start-up a cached route no HTTP caching covers', async () => {
    const routes = new Router('/a')
    routes
      .get('/cached')
      .config('cache', { maxAge: 1 })
      .handler(() => 'never')
    const app = createWebApplication({ adapter: node() }).mount(routes)
    apps.push(app)

    await expect(app.bootstrap()).rejects.toThrow('on the Node application')
  })
})

describe('Node middleware', () => {
  async function run(app: {
    run(options: { host: string; port: number }): Promise<{ address: { origin: string } }>
    close(): Promise<void>
  }): Promise<string> {
    apps.push(app)
    const { address } = await app.run({ host: '127.0.0.1', port: 0 })
    return address.origin
  }

  function latch(): { promise: Promise<void>; release: () => void } {
    let release!: () => void
    const promise = new Promise<void>(resolve => (release = resolve))
    return { promise, release }
  }

  // Mounted under a path, a Node middleware sees the rest of the URL, as connect mounts it; the request gets its own
  // URL back once it calls next.
  it('hands a mounted middleware the rest of the URL and gives it back', async () => {
    const seen: string[] = []
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use('/admin', (req: IncomingMessage, _res: ServerResponse, next: Next) => {
          seen.push(req.url!)
          next()
        })
        .mount(
          new Router('/admin').get('/users', ctx => {
            assert(ctx.platform.name === 'node')
            return ctx.platform.incoming.url ?? ''
          }),
        ),
    )

    const res = await fetch(`${origin}/admin/users?page=2`)

    expect(seen).toEqual(['/users?page=2'])
    expect(await res.text()).toBe('/admin/users?page=2')
  })

  // A middleware that answers on the response itself ends the request: nothing more is written, no onSend runs over
  // what it sent, and onResponse still sees the request end.
  it('answers the request when a middleware ends the response itself', async () => {
    const onSend = vi.fn()
    const ended = latch()
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use((_req: IncomingMessage, res: ServerResponse, _next: Next) => {
          res.statusCode = 401
          res.end('no')
        })
        .hook('onSend', onSend)
        .hook('onResponse', () => ended.release())
        .mount(new Router('/x').get('/', () => 'handler')),
    )

    const res = await fetch(`${origin}/x`)

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('no')
    await ended.promise
    expect(onSend).toHaveBeenCalledTimes(0)
  })

  // An answer the middleware wrote stands even when it calls next anyway: the handler behind it must not run.
  it('runs no handler after a middleware ended the response and called next', async () => {
    let handled = 0
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use((_req: IncomingMessage, res: ServerResponse, next: Next) => {
          res.statusCode = 401
          res.end('no')
          next()
        })
        .mount(
          new Router('/x').get('/', () => {
            handled += 1
            return 'handler'
          }),
        ),
    )

    const res = await fetch(`${origin}/x`)

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('no')
    expect(handled).toBe(0)
  })

  it('keeps the headers a middleware set on the response', async () => {
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use((_req: IncomingMessage, res: ServerResponse, next: Next) => {
          res.setHeader('x-frame-options', 'DENY')
          next()
        })
        .mount(new Router('/x').get('/', () => 'x')),
    )

    const res = await fetch(`${origin}/x`)

    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(await res.text()).toBe('x')
  })

  // A client that leaves while a middleware waits must not keep the request in flight: close() would never drain.
  it('settles the request when the client leaves during a middleware', async () => {
    const entered = latch()
    const app = createWebApplication({ adapter: node() })
      .use((_req: IncomingMessage, _res: ServerResponse, _next: Next) => entered.release())
      .mount(new Router('/x').get('/', () => 'x'))
    const origin = await run(app)
    const controller = new AbortController()

    const pending = fetch(`${origin}/x`, { signal: controller.signal }).catch(() => undefined)
    await entered.promise
    controller.abort()
    await pending

    await expect(app.close()).resolves.toBe(undefined)
  })

  // At onResponse the answer has left, a streamed one included: a Node middleware there still runs, as a logger would.
  it('runs a Node middleware at onResponse after a streamed answer', async () => {
    const ran = latch()
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use(
          (_req: IncomingMessage, res: ServerResponse, next: Next) => {
            ran.release()
            next()
            void res
          },
          { hook: 'onResponse' },
        )
        .mount(new Router('/x').get('/', () => Readable.toWeb(Readable.from(['a'])))),
    )

    expect(await (await fetch(`${origin}/x`)).text()).toBe('a')
    await ran.promise
  })

  // A Node middleware that throws hands the request its URL back, as one that calls next does.
  it('gives the request its URL back when a mounted Node middleware throws', async () => {
    const seen = latch()
    let url: string | undefined
    const origin = await run(
      createWebApplication({ adapter: node() })
        .use('/admin', (_req: IncomingMessage, _res: ServerResponse, _next: Next) => {
          throw new Error('boom')
        })
        .hook('onResponse', ctx => {
          url = (ctx.platform as { incoming: IncomingMessage }).incoming.url
          seen.release()
        })
        .mount(new Router('/admin').get('/users', () => 'users')),
    )

    expect((await fetch(`${origin}/admin/users`)).status).toBe(500)
    await seen.promise
    expect(url).toBe('/admin/users')
  })

  // A streamed answer ends in a `close` event, outside the request's own continuation: onResponse is run inside it.
  it('lets onResponse resolve a request-scoped dependency after a streamed answer', async () => {
    class Session {
      readonly id = Math.random()
    }
    const ids: number[] = []
    const ended = latch()
    const container = new CaffeineIoC()
    container.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))

    const origin = await run(
      createWebApplication({ adapter: node(), container })
        .hook('onRequest', () => void ids.push(container.get(Session).id))
        .hook('onResponse', () => {
          ids.push(container.get(Session).id)
          ended.release()
        })
        .mount(new Router('/x').get('/', () => Readable.toWeb(Readable.from(['a', 'b'])))),
    )

    expect(await (await fetch(`${origin}/x`)).text()).toBe('ab')
    await ended.promise

    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })
})

describe('the request body on Node', () => {
  async function listen(app: App): Promise<number> {
    apps.push(app)
    const { address } = await app.run({ host: '127.0.0.1', port: 0 })
    return address.port
  }

  function echo(): AnyRouter {
    const routes = new Router('/b')
    routes.post('/echo').handler(ctx => ctx.req.body())
    return routes
  }

  const text = (body: string, extra = '') =>
    `POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`

  it('reads a body whole and keeps the connection', async () => {
    const { port } = await serve(echo())

    const answer = await raw(port, text('ping'), /ping$/)

    expect(answer.startsWith('HTTP/1.1 200 OK')).toBe(true)
    expect(answer).toMatch(/\r\nConnection: keep-alive\r\n/i)
  })

  it('answers 413 to a declared length over the limit and closes the connection', async () => {
    const { port } = await serve(echo(), { settings: { bodyLimit: 10 * Byte } })

    const answer = await raw(port, text('x'.repeat(11)))

    expect(answer.startsWith('HTTP/1.1 413')).toBe(true)
    expect(answer).toMatch(/\r\nConnection: close\r\n/i)
  })

  // The refusal closes the connection, whatever answer an error handler makes of it.
  it('closes the connection after refusing a body declared over the limit, though a handler answers 400', async () => {
    const routes = new Router('/b')
    routes
      .post('/echo')
      .bodyLimit(6 * Byte)
      .catchBy([TooLargeAsBadRequest])
      .handler(ctx => ctx.req.body())
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')
    const closed = once(socket, 'close')

    const answered = receive(socket, /too large$/)
    socket.write('POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nping')
    const received = await answered

    expect(received.startsWith('HTTP/1.1 400')).toBe(true)
    expect(received).toMatch(/\r\nConnection: close\r\n/i)
    await closed
  })

  it('answers 413 to a chunked body over the limit and closes the connection', async () => {
    const { port } = await serve(echo(), { settings: { bodyLimit: 10 * Byte } })

    const answer = await raw(
      port,
      'POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\nb\r\nxxxxxxxxxxx\r\n0\r\n\r\n',
    )

    expect(answer.startsWith('HTTP/1.1 413')).toBe(true)
    expect(answer).toMatch(/\r\nConnection: close\r\n/i)
  })

  // A body nothing read is dropped once the answer has gone, as Node drops it, so the connection serves the next
  // request: closing under a client still sending would reset the connection before it read the answer.
  it('keeps the connection after a 415 that left the body unread, and serves the next request on it', async () => {
    const routes = echo()
    routes.get('/next').handler(() => 'next')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const answered = receive(socket, /next$/)
    socket.write('POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>')
    socket.write('GET /b/next HTTP/1.1\r\nHost: x\r\n\r\n')
    const received = await answered

    expect(received.startsWith('HTTP/1.1 415')).toBe(true)
    expect(received).toMatch(/\r\nConnection: keep-alive\r\n/i)
    expect(received).toMatch(/HTTP\/1\.1 200 OK\r\n/)
    socket.destroy()
  })

  it('keeps the connection after an early answer that left the body unread, and serves the next request on it', async () => {
    const routes = new Router('/b')
    routes
      .post('/echo')
      .hook('onRequest', ctx => void ctx.status(401).body('no'))
      .handler(() => 'never')
    routes.get('/next').handler(() => 'next')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const refused = receive(socket, /no$/)
    socket.write('POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')
    const first = await refused
    expect(first.startsWith('HTTP/1.1 401')).toBe(true)
    expect(first).toMatch(/\r\nConnection: keep-alive\r\n/i)

    const served = receive(socket, /next$/)
    socket.write('pong')
    socket.write('GET /b/next HTTP/1.1\r\nHost: x\r\n\r\n')
    expect((await served).startsWith('HTTP/1.1 200')).toBe(true)
    socket.destroy()
  })

  // Only the server refusing the body as too large closes at once: any answer a guard sends to a body declared over the
  // limit, a 413 among them, keeps the connection while the body is dropped, up to the limit.
  it.each([401, 413])(
    'answers keep-alive to a guard %i on a body declared over the limit, then cuts once it passes',
    async status => {
      const routes = new Router('/b')
      routes
        .post('/echo')
        .bodyLimit(6 * Byte)
        .hook('onRequest', ctx => void ctx.status(status).body('no'))
        .handler(() => 'never')
      const { port } = await serve(routes)
      const socket = await connected(port)
      socket.setEncoding('utf8')
      const closed = once(socket, 'close')

      const refused = receive(socket, /no$/)
      socket.write('POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nping')
      const first = await refused
      expect(first.startsWith(`HTTP/1.1 ${status}`)).toBe(true)
      expect(first).toMatch(/\r\nConnection: keep-alive\r\n/i)
      socket.write('pongping')

      await closed
    },
  )

  // A body read through `ctx.req.raw` once the answer has gone was dropped, not read by something else.
  it('fails a read of ctx.req.raw that starts once the answer has gone', async () => {
    const answered = Promise.withResolvers<void>()
    let late: Promise<unknown> = Promise.resolve()
    const routes = new Router('/b')
    routes
      .post('/late')
      .hook('onRequest', ctx => {
        const request = ctx.req.raw
        late = answered.promise
          .then(() => request.arrayBuffer())
          .then(
            () => undefined,
            (err: unknown) => err,
          )
        ctx.status(202).body('accepted')
      })
      .handler(() => 'never')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const accepted = receive(socket, /accepted$/)
    socket.write('POST /b/late HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')
    expect((await accepted).startsWith('HTTP/1.1 202')).toBe(true)
    answered.resolve()

    expect(await late).toMatchObject({ code: 'ERR_REQUEST_BODY_DISCARDED' })
    socket.destroy()
  })

  // No route matched: the body is dropped up to the server's limit.
  it('keeps the connection after a 404 on a request that carries a body', async () => {
    const routes = new Router('/b')
    routes.get('/next').handler(() => 'next')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const answered = receive(socket, /next$/)
    socket.write('POST /nowhere HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nping')
    socket.write('GET /b/next HTTP/1.1\r\nHost: x\r\n\r\n')
    const received = await answered

    expect(received.startsWith('HTTP/1.1 404')).toBe(true)
    expect(received).toMatch(/\r\nConnection: keep-alive\r\n/i)
    expect(received).toMatch(/HTTP\/1\.1 200 OK\r\n/)
    socket.destroy()
  })

  // The body dropped after the answer is held to the request's limit: a client cannot hold the connection by sending
  // on.
  it('closes the connection when a body nothing read goes over its limit after the answer', async () => {
    const routes = new Router('/b')
    routes
      .post('/echo')
      .bodyLimit(6 * Byte)
      .hook('onRequest', ctx => void ctx.status(401).body('no'))
      .handler(() => 'never')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')
    const closed = once(socket, 'close')

    const refused = receive(socket, /no$/)
    socket.write(
      'POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nping\r\n',
    )
    const first = await refused
    expect(first.startsWith('HTTP/1.1 401')).toBe(true)
    expect(first).toMatch(/\r\nConnection: keep-alive\r\n/i)
    socket.write('6\r\npongpo\r\n')

    await closed
  })

  // A route that answers before its body has arrived, and reads on, as a server refusing a token does: the client is
  // still sending, and closing under it would reset the connection before it read the answer.
  function answeringEarly(limit = 1 * MiB): AnyRouter {
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .bodyLimit(limit)
      .handler(ctx => {
        void new Response(ctx.req.body() as ReadableStream<Uint8Array>).arrayBuffer().catch(() => undefined)
        return ctx.status(401).body('no')
      })
    routes.get('/next').handler(() => 'next')
    return routes
  }

  it('keeps the connection of a route that answered while it reads the body, and serves the next request on it', async () => {
    const { port } = await serve(answeringEarly())
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const refused = receive(socket, /no$/)
    socket.write('POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')
    const first = await refused

    expect(first.startsWith('HTTP/1.1 401')).toBe(true)
    expect(first).toMatch(/\r\nConnection: keep-alive\r\n/i)

    const served = receive(socket, /next$/)
    socket.write('pong')
    socket.write('GET /b/next HTTP/1.1\r\nHost: x\r\n\r\n')
    expect((await served).startsWith('HTTP/1.1 200')).toBe(true)
    socket.destroy()
  })

  it('closes the connection when the read of a route that answered early goes over its limit', async () => {
    const { port } = await serve(answeringEarly(6 * Byte))
    const socket = await connected(port)
    socket.setEncoding('utf8')
    const closed = once(socket, 'close')

    const refused = receive(socket, /no$/)
    socket.write(
      'POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nping\r\n',
    )
    expect((await refused).startsWith('HTTP/1.1 401')).toBe(true)
    socket.write('6\r\npongpo\r\n0\r\n\r\n')

    await closed
  })

  // A route that takes the body and never reads it must not hold the connection until Node's `requestTimeout`: the
  // body is larger than every buffer between the socket and the route.
  it('serves the next request on the connection of a route that answered early and never read the body it took', async () => {
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .bodyLimit(4 * MiB)
      .handler(ctx => {
        ;(ctx.req.body() as ReadableStream<Uint8Array>).getReader()
        return ctx.status(401).body('no')
      })
    routes.get('/next').handler(() => 'next')
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const body = Buffer.alloc(2 * MiB, 'x')
    const refused = receive(socket, /no$/)
    socket.write(
      `POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n`,
    )
    expect((await refused).startsWith('HTTP/1.1 401')).toBe(true)

    const served = receive(socket, /next$/)
    socket.write(body)
    socket.write('GET /b/next HTTP/1.1\r\nHost: x\r\n\r\n')
    expect((await served).startsWith('HTTP/1.1 200')).toBe(true)
    socket.destroy()
  })

  // In process, the request has no socket to cut: a route that cancels its read once the head is out still has its
  // answer end.
  it('ends the answer of an in-process route that cancels its read after its head is out', async () => {
    const head = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    let cancelled: Promise<void> = Promise.resolve()
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .handler(ctx => {
        const body = ctx.req.body() as ReadableStream<Uint8Array>
        cancelled = head.promise.then(() => body.cancel())
        return new ReadableStream<Uint8Array>({ start: controller => answer.resolve(controller) })
      })
    const app = createWebApplication({ adapter: node() })
      .logger(b => b.use(newNoopLogger()))
      .mount(routes)
    apps.push(app)
    await app.bootstrap()

    const res = await app.request('/b/early', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'ping',
    })
    head.resolve()
    await cancelled
    ;(await answer.promise).close()

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  // Once its answer has gone, the route cannot read what is left: the server discards it to keep the connection.
  it('fails the read of a route that answered early once the answer has gone', async () => {
    let failure: Promise<unknown> = Promise.resolve()
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .handler(ctx => {
        failure = readAll(ctx.req.body() as ReadableStream<Uint8Array>).then(
          () => undefined,
          (err: unknown) => err,
        )
        return ctx.status(401).body('no')
      })
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const refused = receive(socket, /no$/)
    socket.write('POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')
    expect((await refused).startsWith('HTTP/1.1 401')).toBe(true)

    expect(await failure).toMatchObject({ code: 'ERR_REQUEST_BODY_DISCARDED' })
    socket.destroy()
  })

  // A body something other than the route's stream started reading is left as it is: a kept connection would hold it
  // half-read, and the next request on it would never be served.
  it('closes the connection after a Node middleware read part of the body and stopped', async () => {
    const routes = new Router('/b')
    routes.post('/partial').handler(() => 'never')
    const port = await listen(
      createWebApplication({ adapter: node() })
        .logger(b => b.use(newNoopLogger()))
        .use((req: IncomingMessage, _res: ServerResponse, next: Next) => {
          req.once('data', () => {
            req.pause()
            next(new Error('stopped'))
          })
        })
        .mount(routes),
    )
    const socket = await connected(port)
    socket.setEncoding('utf8')

    const answered = receive(socket, /\r\n\r\n/)
    socket.write('POST /b/partial HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')
    const received = await answered

    expect(received.startsWith('HTTP/1.1 500')).toBe(true)
    expect(received).toMatch(/\r\nConnection: close\r\n/i)
    socket.destroy()
  })

  // The head goes out on a kept connection while the answer streams; the read that then goes over its limit leaves the
  // rest of the body unread, so the connection closes once the answer ends.
  it('closes the connection when a read goes over its limit while the answer streams', async () => {
    const answer = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    let failure: Promise<unknown> = Promise.resolve()
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .bodyLimit(6 * Byte)
      .handler(ctx => {
        failure = readAll(ctx.req.body() as ReadableStream<Uint8Array>).then(
          () => undefined,
          (err: unknown) => err,
        )
        // A first chunk sends the head: Node holds it until the body starts.
        return new ReadableStream<Uint8Array>({
          start: controller => {
            controller.enqueue(new TextEncoder().encode('a'))
            answer.resolve(controller)
          },
        })
      })
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')
    const closed = once(socket, 'close')

    const headed = receive(socket, /\r\n\r\n/)
    socket.write(
      'POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nping\r\n',
    )
    const received = await headed
    expect(received.startsWith('HTTP/1.1 200')).toBe(true)
    expect(received).toMatch(/\r\nConnection: keep-alive\r\n/i)

    socket.write('6\r\npongpo\r\n')
    expect(await failure).toMatchObject({ code: 'ERR_HTTP_CONTENT_TOO_LARGE' })
    ;(await answer.promise).close()

    await closed
  })

  it('closes the connection when a route cancels its read before answering', async () => {
    const routes = new Router('/b')
    routes
      .post('/early')
      .extend(bodyAsStream())
      .handler(async ctx => {
        const reader = (ctx.req.body() as ReadableStream<Uint8Array>).getReader()
        await reader.read()
        await reader.cancel()
        return ctx.status(401).body('no')
      })
    const { port } = await serve(routes)
    const socket = await connected(port)
    socket.setEncoding('utf8')
    const closed = once(socket, 'close')

    const refused = receive(socket, /no$/)
    socket.write('POST /b/early HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\nping')

    expect((await refused).startsWith('HTTP/1.1 401')).toBe(true)
    await closed
  })

  it('closes the connection after a Node middleware answered without reading the body', async () => {
    const port = await listen(
      createWebApplication({ adapter: node() })
        .logger(b => b.use(newNoopLogger()))
        .use((_req: IncomingMessage, res: ServerResponse, _next: Next) => {
          res.statusCode = 401
          res.end('no')
        })
        .mount(echo()),
    )

    const answer = await raw(port, text('ping'))

    expect(answer.startsWith('HTTP/1.1 401')).toBe(true)
    expect(answer).toMatch(/\r\nConnection: close\r\n/i)
  })

  it('reads a body over HTTP/2', async () => {
    const { origin } = await serve(echo(), { settings: { http2: true } })

    const session = http2Connect(origin)
    try {
      const stream = session.request({ ':method': 'POST', ':path': '/b/echo', 'content-type': 'text/plain' })
      stream.setEncoding('utf8')
      let body = ''
      stream.on('data', (chunk: string) => (body += chunk))
      stream.end('ping')
      await once(stream, 'end')

      expect(body).toBe('ping')
    } finally {
      session.close()
    }
  })

  // The client left: its request is cut short, not read by something before the route.
  it('answers a client that left before its body arrived as cut short', async () => {
    const entered = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<unknown>()
    const routes = new Router('/b')
    routes
      .post('/slow')
      .hook('onRequest', async ctx => {
        entered.resolve()
        await once(ctx.signal, 'abort')
      })
      .hook('onError', (_ctx, err) => failed.resolve(err))
      .handler(() => 'never')
    const { port } = await serve(routes)

    const socket = await connected(port)
    socket.write('POST /b/slow HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\n')
    await entered.promise
    socket.destroy()

    expect(await failed.promise).toMatchObject({ statusCode: 400 })
  })

  // HTTP/2 sends a body without Content-Length: the bytes read are kept for ctx.req.raw all the same.
  it('serves the bytes read through ctx.req.raw for an HTTP/2 body without Content-Length', async () => {
    const routes = new Router('/b')
    routes.post('/raw').handler(async ctx => ({ body: ctx.req.body(), raw: await ctx.req.raw.text() }))
    const { origin } = await serve(routes, { settings: { http2: true } })

    const session = http2Connect(origin)
    try {
      const stream = session.request({ ':method': 'POST', ':path': '/b/raw', 'content-type': 'text/plain' })
      stream.setEncoding('utf8')
      let answer = ''
      stream.on('data', (chunk: string) => (answer += chunk))
      stream.end('ping')
      await once(stream, 'end')

      expect(JSON.parse(answer)).toEqual({ body: 'ping', raw: 'ping' })
    } finally {
      session.close()
    }
  })

  // What the route failed to read whole is not served as if whole: ctx.req.raw refuses it.
  it('refuses ctx.req.raw a body the route failed to read past its limit', async () => {
    const outcome = Promise.withResolvers<string>()
    const routes = new Router('/b')
    routes
      .post('/echo')
      .hook('onError', async ctx => {
        try {
          outcome.resolve(`read "${await ctx.req.raw.text()}"`)
        } catch (err) {
          outcome.resolve(`refused ${String((err as { statusCode?: number }).statusCode)}`)
        }
      })
      .handler(() => 'never')
    const { port } = await serve(routes, { settings: { bodyLimit: 10 * Byte } })

    await raw(
      port,
      'POST /b/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\nb\r\nxxxxxxxxxxx\r\n4\r\ntail\r\n0\r\n\r\n',
    )

    expect(await outcome.promise).toBe('refused 413')
  })

  it('refuses ctx.req.raw a body a Node middleware started reading', async () => {
    const outcome = Promise.withResolvers<string>()
    const routes = new Router('/b')
    routes
      .post('/echo')
      .hook('onError', async ctx => {
        try {
          outcome.resolve(`read "${await ctx.req.raw.text()}"`)
        } catch (err) {
          outcome.resolve(`refused ${String((err as { code?: string }).code)}`)
        }
      })
      .handler(() => 'never')
    const port = await listen(
      createWebApplication({ adapter: node() })
        .logger(b => b.use(newNoopLogger()))
        .use((req: IncomingMessage, _res: ServerResponse, next: Next) => {
          req.once('data', () => {
            req.pause()
            next()
          })
        })
        .mount(routes),
    )

    await raw(port, text('ping'), /\r\n\r\n/)

    expect(await outcome.promise).toBe('refused ERR_REQUEST_BODY_CONSUMED')
  })

  it('holds a body read through ctx.req.raw to the limit', async () => {
    const routes = new Router('/b')
    routes
      .post('/echo')
      .hook('onRequest', async ctx => void (await ctx.req.raw.text()))
      .handler(() => 'never')
    const { port } = await serve(routes, { settings: { bodyLimit: 10 * Byte } })

    const answer = await raw(port, text('x'.repeat(11)))

    expect(answer.startsWith('HTTP/1.1 413')).toBe(true)
  })

  it('serves the bytes read through the ctx.req.raw a hook saw before the body was read', async () => {
    let seen: Request | undefined
    const routes = new Router('/b')
    routes
      .post('/echo')
      .hook('onRequest', ctx => void (seen = ctx.req.raw))
      .handler(async ctx => ({ same: ctx.req.raw === seen, text: await ctx.req.raw.text(), body: ctx.req.body() }))
    const { origin } = await serve(routes)

    const res = await fetch(`${origin}/b/echo`, { method: 'POST', body: 'ping' })

    expect(await res.json()).toEqual({ same: true, text: 'ping', body: 'ping' })
  })

  it.each([
    ['a parsed body', (routes: AnyRouter) => void routes.post('/read').handler(() => 'never')],
    [
      'a @BodyAsStream body',
      (routes: AnyRouter) =>
        void routes
          .post('/read')
          .extend(bodyAsStream())
          .handler(() => 'never'),
    ],
  ])('answers 500 to %s a Node middleware started reading', async (_case, declare) => {
    const error = vi.fn()
    const routes = new Router('/b')
    declare(routes)
    const port = await listen(
      createWebApplication({ adapter: node() })
        .logger(b => b.use({ ...newNoopLogger(), error }))
        .use((req: IncomingMessage, _res: ServerResponse, next: Next) => {
          req.once('data', () => {
            req.pause()
            next()
          })
        })
        .mount(routes),
    )

    const answer = await raw(
      port,
      'POST /b/read HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nping',
      /\r\n\r\n/,
    )

    expect(answer.startsWith('HTTP/1.1 500')).toBe(true)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code: 'ERR_REQUEST_BODY_CONSUMED' }) }),
      expect.any(String),
    )
  })
})
