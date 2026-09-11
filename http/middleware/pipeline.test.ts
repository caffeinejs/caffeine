import type { IncomingMessage, ServerResponse } from 'node:http'

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
  options: { context?: boolean; container?: Container; configuration?: Configuration<unknown> } = {},
): Promise<FastifyInstance> {
  const server = fastify()
  if (options.context !== false) {
    attachContext(server)
  }

  const container = options.container ?? ({} as Container)
  pipeline.setupAll(container)
  pipeline.installHooks(server, container, options.configuration ?? emptyConfiguration())
  server.get('/echo', () => ({ ok: true }))
  server.get('/api/echo', () => ({ ok: true }))
  await server.ready()
  return server
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

  it('installs each non-empty hook once', async () => {
    const added: string[] = []
    const server = {
      addHook: (hook: string) => {
        added.push(hook)
      },
    } as never

    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'onRequest')
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'onRequest')
    pipeline.add(undefined, (_ctx: Context, next: Next) => next(), 'preHandler')
    pipeline.setupAll({} as Container)
    pipeline.installHooks(server, {} as Container, emptyConfiguration())

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

  it('reports whether a middleware type is registered', () => {
    class Marker implements Middleware {
      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, new Marker(), 'onRequest')

    expect(pipeline.has(Marker)).toBe(true)
    expect(pipeline.has(MiddlewarePipeline)).toBe(false)
  })

  it('refuses a registration once the pipeline is sealed', () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.setupAll({} as Container)

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
    pipeline.setupAll(container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      container,
      emptyConfiguration(),
    )

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
    pipeline.setupAll(container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      container,
      emptyConfiguration(),
    )

    expect(added).toEqual(['onRequest'])
  })

  it('uses a function hook hint when none is passed', () => {
    const mw: MiddlewareFn = (_ctx, next) => next()
    Object.defineProperty(mw, kMiddlewareHook, { value: 'preHandler' })

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, mw)
    pipeline.setupAll({} as Container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      {} as Container,
      emptyConfiguration(),
    )

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
    pipeline.setupAll({} as Container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      {} as Container,
      emptyConfiguration(),
    )

    expect(added).toEqual(['preHandler'])
  })

  it('ignores a hook hint planted on Node middleware', () => {
    const mw = ((_req: IncomingMessage, _res: ServerResponse, next: Next) => next()) as NodeMiddleware
    Object.defineProperty(mw, kMiddlewareHook, { value: 'preHandler' })

    const added: string[] = []
    const pipeline = new MiddlewarePipeline()
    pipeline.add(undefined, mw)
    pipeline.setupAll({} as Container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      {} as Container,
      emptyConfiguration(),
    )

    expect(added).toEqual(['onRequest'])
  })

  it('throws when a hook hint is not a middleware hook', () => {
    class Bad implements Middleware {
      static get [kMiddlewareHook](): MiddlewareHook {
        return 'nope' as MiddlewareHook
      }

      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const pipeline = new MiddlewarePipeline()
    expect(() => pipeline.add(undefined, Bad)).toThrow('is not a middleware hook')
  })

  it('picks up a class hook hint from a container token after resolveAll', async () => {
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
    pipeline.setupAll(container)
    pipeline.installHooks(
      { addHook: (hook: string) => void added.push(hook) } as never,
      container,
      emptyConfiguration(),
    )

    expect(added).toEqual(['preHandler'])
  })
})
