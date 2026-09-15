import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AddressInfo, connect } from 'node:net'

import { CaffeineIoC, token, type Container } from '@caffeinejs/di'
import type { Configuration } from '@caffeinejs/std/config'
import fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { describe, expect, it } from 'vitest'

import type { Context } from '../context.js'
import { Keys } from '../symbols.js'
import { ErrNextCalledTwice } from './errors.js'
import {
  type Middleware,
  type MiddlewareFn,
  type MiddlewareHook,
  type Next,
  type NodeMiddleware,
  kMiddlewareHook,
} from './middleware.js'
import { MiddlewarePipeline } from './pipeline.js'

type RawRequest = IncomingMessage & Record<string, unknown>

function emptyConfiguration(config: object = {}): Configuration<unknown> {
  return { config } as Configuration<unknown>
}

function contextStub(reply: FastifyReply): Context {
  const ctx = {
    header(key: string, value: string) {
      reply.header(key, value)
      return ctx
    },
    status(code: number) {
      reply.code(code)
      return ctx
    },
    body(body?: unknown) {
      reply.send(body)
      return ctx
    },
  }
  return ctx as unknown as Context
}

function attachContext(server: FastifyInstance): void {
  server.addHook('onRequest', (req, reply, done) => {
    Object.defineProperty(req.raw, Keys.CONTEXT, {
      value: contextStub(reply),
      writable: false,
      configurable: false,
    })
    done()
  })
}

async function serve(
  pipeline: MiddlewarePipeline,
  options: {
    context?: boolean
    container?: Container
    configuration?: Configuration<unknown>
    server?: FastifyInstance
    routes?: (server: FastifyInstance) => void
  } = {},
): Promise<FastifyInstance> {
  const server = options.server ?? fastify()
  if (options.context !== false) {
    attachContext(server)
  }

  pipeline.install(server, options.container ?? ({} as Container), options.configuration ?? emptyConfiguration())
  server.get('/echo', () => ({ ok: true }))
  server.get('/api/echo', () => ({ ok: true }))
  options.routes?.(server)
  await server.ready()
  return server
}

function stubServer(added: string[]): FastifyInstance {
  return { addHook: (hook: string) => void added.push(hook), initialConfig: {} } as never
}

// Blocks every request that does not carry the key, the way a path-scoped auth middleware would.
const guard: NodeMiddleware = (req, res, next) => {
  if (req.headers['x-api-key'] !== 'key') {
    res.statusCode = 401
    res.end('blocked')
    return
  }
  next()
}

// Sends an absolute-form request target over a socket; `inject` would parse the URL before Fastify sees it.
async function rawRequest(server: FastifyInstance, target: string): Promise<string> {
  if (!server.server.listening) {
    await server.listen({ port: 0, host: '127.0.0.1' })
  }
  const { port } = server.server.address() as AddressInfo

  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.end(`GET ${target} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n`)
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      response += chunk
    })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

describe('MiddlewarePipeline', () => {
  it('runs middlewares in registration order within a hook', async () => {
    const order: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      (_ctx: Context, next: Next) => {
        order.push('first')
        next()
      },
      'onRequest',
    )
    pipeline.add(
      undefined,
      (_ctx: Context, next: Next) => {
        order.push('second')
        next()
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    await server.inject('/echo')
    expect(order).toEqual(['first', 'second'])
    await server.close()
  })

  it('restricts a middleware to a path prefix', async () => {
    const seen: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      '/api',
      (_ctx: Context, next: Next) => {
        seen.push('api')
        next()
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    await server.inject('/echo')
    await server.inject('/api/echo')
    expect(seen).toEqual(['api'])
    await server.close()
  })

  it('treats "*" as every request', async () => {
    const seen: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      '*',
      (_ctx: Context, next: Next) => {
        seen.push('all')
        next()
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    await server.inject('/echo')
    await server.inject('/api/echo')
    expect(seen).toEqual(['all', 'all'])
    await server.close()
  })

  it('installs each non-empty hook once', () => {
    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'onRequest')
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'onRequest')
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'preHandler')
    pipeline.install(stubServer(added), {} as Container, emptyConfiguration())

    expect(added).toEqual(['onRequest', 'preHandler'])
  })

  it('runs a config factory once at install with the live config handle', async () => {
    const config = { origin: 'from-config' }
    let factoryRuns = 0
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      (c: { origin: string }) => {
        factoryRuns += 1
        return (_ctx: Context, next: Next) => {
          _ctx.header('x-origin', c.origin)
          next()
        }
      },
      'onRequest',
    )

    const server = await serve(pipeline, { configuration: emptyConfiguration(config) })
    const first = await server.inject('/echo')
    const second = await server.inject('/echo')

    expect(factoryRuns).toBe(1)
    expect(first.headers['x-origin']).toBe('from-config')
    expect(second.headers['x-origin']).toBe('from-config')
    await server.close()
  })

  it('resolves a middleware class from the container', async () => {
    class Tagger implements Middleware {
      handle(ctx: Context, next: Next): void {
        ctx.header('x-tag', 'class')
        next()
      }
    }

    const container = new CaffeineIoC()
    container.bind(Tagger, t => t.toClass(Tagger))
    await container.init()

    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, Tagger, 'onRequest')

    const server = await serve(pipeline, { container })
    const res = await server.inject('/echo')
    expect(res.headers['x-tag']).toBe('class')
    await server.close()
  })

  it('resolves a middleware registered by container key', async () => {
    class Tagger implements Middleware {
      handle(ctx: Context, next: Next): void {
        ctx.header('x-tag', 'key')
        next()
      }
    }

    const kTagger = token<Tagger>(Symbol('tagger'))
    const container = new CaffeineIoC()
    container.bind(kTagger, t => t.toClass(Tagger))
    await container.init()

    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, kTagger, 'onRequest')

    const server = await serve(pipeline, { container })
    const res = await server.inject('/echo')
    expect(res.headers['x-tag']).toBe('key')
    await server.close()
  })

  it('rejects a second next() from a Caffeine middleware', async () => {
    let thrown: unknown
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      (_ctx: Context, next: Next) => {
        next()
        try {
          next()
        } catch (err) {
          thrown = err
        }
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    await server.inject('/echo')
    expect(thrown).toBeInstanceOf(ErrNextCalledTwice)
    await server.close()
  })

  it('does not wrap Node middleware with double-next protection', async () => {
    let thrown: unknown
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      (_req: IncomingMessage, _res: ServerResponse, next: Next) => {
        next()
        try {
          next()
        } catch (err) {
          thrown = err
        }
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    await server.inject('/echo')
    expect(thrown).not.toBeInstanceOf(ErrNextCalledTwice)
    await server.close()
  })

  it('skips the engine when the raw request has no context', async () => {
    let ran = false
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      () => {
        ran = true
      },
      'onRequest',
    )

    const server = await serve(pipeline, { context: false })
    const res = await server.inject('/echo')
    expect(ran).toBe(false)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await server.close()
  })

  it('short-circuits when a middleware answers with ctx.body() and does not call next', async () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.add(
      undefined,
      (ctx: Context, _next: Next) => {
        ctx.status(418).body({ answered: 'directly' })
      },
      'onRequest',
    )

    const server = await serve(pipeline)
    const res = await server.inject('/echo')
    expect(res.statusCode).toBe(418)
    expect(res.json()).toEqual({ answered: 'directly' })
    await server.close()
  })

  it('refuses a registration once the pipeline is installed', () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.install(stubServer([]), {} as Container, emptyConfiguration())

    expect(() => pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'onRequest')).toThrow(
      'the application is already started',
    )
  })

  it('uses a class static hook hint when none is passed', async () => {
    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const container = new CaffeineIoC()
    container.bind(Hinted, t => t.toClass(Hinted))
    await container.init()

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, Hinted)
    pipeline.install(stubServer(added), container, emptyConfiguration())

    expect(added).toEqual(['preHandler'])
  })

  it('lets { hook } override a class static hook hint', async () => {
    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const container = new CaffeineIoC()
    container.bind(Hinted, t => t.toClass(Hinted))
    await container.init()

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, Hinted, 'onRequest')
    pipeline.install(stubServer(added), container, emptyConfiguration())

    expect(added).toEqual(['onRequest'])
  })

  it('uses a function hook hint when none is passed', () => {
    const mw: MiddlewareFn = (_ctx, next) => next()
    Object.defineProperty(mw, kMiddlewareHook, { value: 'preHandler' })

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, mw)
    pipeline.install(stubServer(added), {} as Container, emptyConfiguration())

    expect(added).toEqual(['preHandler'])
  })

  it('reads a class hook hint from an instance constructor', () => {
    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, new Hinted())
    pipeline.install(stubServer(added), {} as Container, emptyConfiguration())

    expect(added).toEqual(['preHandler'])
  })

  it('ignores a hook hint planted on Node middleware', () => {
    const mw = ((_req: IncomingMessage, _res: ServerResponse, next: Next) => next()) as NodeMiddleware
    Object.defineProperty(mw, kMiddlewareHook, { value: 'preHandler' })

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, mw)
    pipeline.install(stubServer(added), {} as Container, emptyConfiguration())

    expect(added).toEqual(['onRequest'])
  })

  it('throws at install when a hook hint is not a middleware hook', async () => {
    class Bad implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'nope' as MiddlewareHook
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const container = new CaffeineIoC()
    container.bind(Bad, t => t.toClass(Bad))
    await container.init()

    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, Bad)

    expect(() => pipeline.install(stubServer([]), container, emptyConfiguration())).toThrow('is not a middleware hook')
  })

  it('picks up a class hook hint from a container token', async () => {
    class Hinted implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'preHandler'
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const kHinted = token<Hinted>(Symbol('hinted'))
    const container = new CaffeineIoC()
    container.bind(kHinted, t => t.toClass(Hinted))
    await container.init()

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, kHinted)
    pipeline.install(stubServer(added), container, emptyConfiguration())

    expect(added).toEqual(['preHandler'])
  })
})

// A path-scoped middleware is often a guard. Every URL the router sends to the guarded route must reach the
// middleware too, or the guard is bypassed.
describe('MiddlewarePipeline path matching', () => {
  it('guards a parameterized prefix against an encoded slash in the parameter', async () => {
    const pipeline = new MiddlewarePipeline().add('/user/:id/comments', guard)
    const server = await serve(pipeline, {
      routes: s => s.get('/user/:id/comments', req => ({ id: (req.params as { id: string }).id })),
    })

    expect((await server.inject('/user/alice/comments')).statusCode).toBe(401)
    expect((await server.inject('/user/a%2Fb/comments')).statusCode).toBe(401)

    const allowed = await server.inject({ url: '/user/a%2Fb/comments', headers: { 'x-api-key': 'key' } })
    expect(allowed.json()).toEqual({ id: 'a/b' })
    await server.close()
  })

  it('guards a prefix against absolute-form request targets', async () => {
    const pipeline = new MiddlewarePipeline().add('/private', guard)
    const server = await serve(pipeline, { routes: s => s.get('/private/secrets', () => ({ secret: true })) })

    for (const target of [
      '/private/secrets',
      'http://evil.example/private/secrets',
      'HtTp://evil.example/private/secrets',
      'http://user:password@evil.example:8080/private/secrets?x=1',
    ]) {
      expect(await rawRequest(server, target), target).toMatch(/^HTTP\/1\.1 401 /)
    }
    await server.close()
  })

  it('guards a prefix against the variants the router options normalize away', async () => {
    const routerOptions = { ignoreDuplicateSlashes: true, ignoreTrailingSlash: true, useSemicolonDelimiter: true }
    const pipeline = new MiddlewarePipeline().add('/secret', guard)
    const server = await serve(pipeline, {
      server: fastify({ routerOptions }),
      routes: s => s.get('/secret', () => ({ secret: true })),
    })

    for (const url of ['/secret', '//secret', '/secret/', '/secret;a=b']) {
      expect((await server.inject(url)).statusCode, url).toBe(401)
    }
    expect((await server.inject({ url: '//secret', headers: { 'x-api-key': 'key' } })).statusCode).toBe(200)
    await server.close()
  })

  it('rejects a malformed percent-encoding with 400 before any middleware runs', async () => {
    let ran = false
    const pipeline = new MiddlewarePipeline().add('/secret', ((_req, _res, next) => {
      ran = true
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline, { routes: s => s.get('/secret/*', () => ({ secret: true })) })

    const res = await server.inject('/secret/%zz')
    expect(res.statusCode).toBe(400)
    expect(ran).toBe(false)
    await server.close()
  })

  it('strips the prefix from req.url, keeping encoded characters and the query string', async () => {
    let captured: string | undefined
    const pipeline = new MiddlewarePipeline().add('/prefix', ((req, _res, next) => {
      captured = req.url
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline, { routes: s => s.get('/prefix/*', () => ({ ok: true })) })

    await server.inject('/prefix/hello%20world%2Ffoo?x=1')
    expect(captured).toBe('/hello%20world%2Ffoo?x=1')
    await server.close()
  })

  it('strips a parameterized prefix without splitting an encoded slash', async () => {
    let captured: string | undefined
    const pipeline = new MiddlewarePipeline().add('/user/:id', ((req, _res, next) => {
      captured = req.url
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline, { routes: s => s.get('/user/:id/comments', () => ({ ok: true })) })

    await server.inject('/user/a%2Fb/comments')
    expect(captured).toBe('/comments')
    await server.close()
  })

  it('runs a middleware registered under several prefixes on each of them', async () => {
    const seen: string[] = []
    const pipeline = new MiddlewarePipeline().add(['/echo', '/api'], ((req, _res, next) => {
      seen.push(String((req as RawRequest).originalUrl))
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline, { routes: s => s.get('/other', () => ({ ok: true })) })

    await server.inject('/echo')
    await server.inject('/api/echo')
    await server.inject('/other')
    expect(seen).toEqual(['/echo', '/api/echo'])
    await server.close()
  })
})

// Connect-style middleware from the Node ecosystem (cors, serve-static, rate limiters) relies on each of these.
describe('MiddlewarePipeline connect-style middleware', () => {
  it('sees the Express-style request fields', async () => {
    let fields: Record<string, unknown> = {}
    const pipeline = new MiddlewarePipeline().add(undefined, ((req, _res, next) => {
      const raw = req as RawRequest
      fields = { originalUrl: raw.originalUrl, id: raw.id, ip: raw.ip, query: raw.query, hasBody: 'body' in raw }
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline)

    await server.inject('/echo?q=1')
    expect(fields).toEqual({
      originalUrl: '/echo?q=1',
      id: expect.any(String),
      ip: '127.0.0.1',
      query: { q: '1' },
      hasBody: false,
    })
    await server.close()
  })

  it('sees the parsed body at preHandler', async () => {
    let body: unknown
    const pipeline = new MiddlewarePipeline().add(
      undefined,
      ((req, _res, next) => {
        body = (req as RawRequest).body
        next()
      }) as NodeMiddleware,
      'preHandler',
    )
    const server = await serve(pipeline, { routes: s => s.post('/body', () => ({ ok: true })) })

    await server.inject({ method: 'POST', url: '/body', payload: { a: 1 } })
    expect(body).toEqual({ a: 1 })
    await server.close()
  })

  it('sees req.url relative to its mount path, restored for the handler', async () => {
    let captured: string | undefined
    const pipeline = new MiddlewarePipeline().add('/static', ((req, _res, next) => {
      captured = req.url
      next()
    }) as NodeMiddleware)
    const server = await serve(pipeline, { routes: s => s.get('/static/*', req => ({ url: req.raw.url })) })

    const res = await server.inject('/static/file.txt')
    expect(captured).toBe('/file.txt')
    expect(res.json()).toEqual({ url: '/static/file.txt' })
    await server.close()
  })

  it('answers with res.end() and stops the chain and the handler', async () => {
    const reached: string[] = []
    const pipeline = new MiddlewarePipeline()
      .add(undefined, ((_req, res, _next) => {
        res.end('early')
      }) as NodeMiddleware)
      .add(undefined, ((_req, _res, next) => {
        reached.push('second')
        next()
      }) as NodeMiddleware)
    const server = await serve(pipeline, {
      routes: s =>
        s.get('/handled', () => {
          reached.push('handler')
          return { ok: true }
        }),
    })

    const res = await server.inject('/handled')
    expect(res.body).toBe('early')
    expect(reached).toEqual([])
    await server.close()
  })

  it('fails the request with next(err) and skips the rest', async () => {
    const reached: string[] = []
    const pipeline = new MiddlewarePipeline()
      .add(undefined, ((_req, _res, next) => next(new Error('boom'))) as NodeMiddleware)
      .add(undefined, ((_req, _res, next) => {
        reached.push('second')
        next()
      }) as NodeMiddleware)
    const server = await serve(pipeline)

    const res = await server.inject('/echo')
    expect(res.statusCode).toBe(500)
    expect(reached).toEqual([])
    await server.close()
  })

  it('runs when a config factory returns it', async () => {
    const pipeline = new MiddlewarePipeline().add(
      undefined,
      (c: { tag: string }) =>
        ((_req, res, next) => {
          res.setHeader('x-tag', c.tag)
          next()
        }) as NodeMiddleware,
    )
    const server = await serve(pipeline, { configuration: emptyConfiguration({ tag: 'factory' }) })

    const res = await server.inject('/echo')
    expect(res.headers['x-tag']).toBe('factory')
    await server.close()
  })

  it('runs at a payload hook', async () => {
    const pipeline = new MiddlewarePipeline().add(
      undefined,
      ((_req, res, next) => {
        res.setHeader('x-sent', 'yes')
        next()
      }) as NodeMiddleware,
      'onSend',
    )
    const server = await serve(pipeline)

    const res = await server.inject('/echo')
    expect(res.headers['x-sent']).toBe('yes')
    await server.close()
  })
})
