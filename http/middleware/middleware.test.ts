import type { IncomingMessage } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import cors from 'cors'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, it, expect } from 'vitest'

import {
  type Context,
  Controller,
  ErrHTTPForbidden,
  ErrPipelineSealed,
  Get,
  type HTTPSetupContext,
  type Middleware,
  type MiddlewareFn,
  type NodeMiddleware,
  type WebApplication,
  type FastifyMiddlewareHook,
  type Next,
  Router,
  createWebApplication,
  kMiddlewareHook,
} from '../index.js'

@Controller('/mw')
class MiddlewareController {
  @Get('/echo')
  echo() {
    return { ok: true }
  }
}
void [MiddlewareController]

const kTagger = token<Tagger>(Symbol('tagger'))
const stringKey = token<Tagger>('mounted-tagger')

class Tag {
  constructor(readonly value: string) {}
}

class Tagger implements Middleware {
  constructor(private readonly tag: Tag) {}

  handle(ctx: Context, next: Next): void {
    ctx.header('x-tag', this.tag.value)
    next()
  }
}

let counterInstances = 0

class Counter implements Middleware {
  readonly id = ++counterInstances

  handle(ctx: Context, next: Next): void {
    ctx.header('x-instance', String(this.id))
    next()
  }
}

function newApp(configure: (container: CaffeineIoC) => void = () => {}) {
  const container = new CaffeineIoC()
  configure(container)
  return createWebApplication({ container })
}

describe('middleware pipeline', () => {
  it('runs a function middleware before the handler', async () => {
    const seen: string[] = []

    const app = newApp()
    app.use((_ctx, next) => {
      seen.push('mw')
      next()
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(seen).toEqual(['mw'])
    await app.close()
  })

  it('runs a one-argument Caffeine middleware instead of treating it as a factory', async () => {
    const app = newApp()
    app.use(ctx => {
      ctx.header('x-tag', 'one-argument')
      ctx.status(401).body({ error: 'anonymous' })
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(401)
    expect(res.headers.get('x-tag')).toBe('one-argument')
    expect(await res.json()).toEqual({ error: 'anonymous' })
    await app.close()
  })

  it('infers a configured factory alongside Caffeine middleware', async () => {
    const schema = $t.Object({ middleware: $t.Object({ tag: $t.String() }) })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('middleware.app.config'))
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ middleware: { tag: 'from-config' } }))
      .build()
    const app = createWebApplication({ container: new CaffeineIoC(), config: conf })
    const seen: string[] = []

    app.useFn('*', ({ config }) => ({
      handle(ctx, next) {
        ctx.header('x-tag', config.middleware.tag)
        next()
      },
    }))
    app.use('*', (ctx, next) => {
      seen.push(`caffeine:${ctx.req.url}`)
      next()
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tag')).toBe('from-config')
    expect(seen).toEqual(['caffeine:/mw/echo'])
    await app.close()
  })

  it('resolves a middleware class from the container, with its dependencies injected', async () => {
    const app = newApp(container => {
      container.bind(Tag, t => t.toValue(new Tag('injected')))
      container.bind(Tagger, t => t.toClass(Tagger, [Tag]))
    })
    app.use(Tagger)
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.headers.get('x-tag')).toBe('injected')
    await app.close()
  })

  it('resolves a middleware registered by container key', async () => {
    const app = newApp(container => {
      container.bind(Tag, t => t.toValue(new Tag('by-key')))
      container.bind(kTagger, t => t.toClass(Tagger, [Tag]))
    })
    app.use(kTagger)
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.headers.get('x-tag')).toBe('by-key')
    await app.close()
  })

  it('resolves a request-scoped middleware once per request, a singleton once for the process', async () => {
    counterInstances = 0

    const scoped = newApp(container => {
      container.bind(Counter, t => t.toClass(Counter).lifetime(Scopes.REQUEST))
    })
    scoped.use(Counter)
    await scoped.bootstrap()

    const first = await scoped.fetch('/mw/echo')
    const second = await scoped.fetch('/mw/echo')
    expect(first.headers.get('x-instance')).not.toBe(second.headers.get('x-instance'))
    await scoped.close()

    const singleton = newApp(container => {
      container.bind(Counter, t => t.toClass(Counter))
    })
    singleton.use(Counter)
    await singleton.bootstrap()

    const third = await singleton.fetch('/mw/echo')
    const fourth = await singleton.fetch('/mw/echo')
    expect(third.headers.get('x-instance')).toBe(fourth.headers.get('x-instance'))
    await singleton.close()
  })

  it('runs an onRequest middleware before a preHandler one', async () => {
    const order: string[] = []

    const app = newApp()
    app.use((_ctx, next) => {
      order.push('onRequest')
      next()
    })
    app.use(
      (_ctx, next) => {
        order.push('preHandler')
        next()
      },
      { hook: 'preHandler' },
    )
    await app.bootstrap()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['onRequest', 'preHandler'])
    await app.close()
  })

  it('short-circuits from onRequest, skipping later middleware and the handler', async () => {
    const reached: string[] = []

    const app = newApp()
    app.use(
      (_ctx, next) => {
        reached.push('preHandler')
        next()
      },
      { hook: 'preHandler' },
    )
    app.use((ctx, _next) => {
      ctx.status(401).body({ error: 'anonymous' })
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'anonymous' })
    expect(reached).toEqual([])
    await app.close()
  })

  it('leaves a reply a middleware answered itself alone', async () => {
    const app = newApp()
    app.use((ctx, _next) => {
      ctx.status(418).body({ answered: 'directly' })
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ answered: 'directly' })
    await app.close()
  })

  // `writableEnded` is false for as long as an `onSend` hook that awaits holds the middleware's answer open, so
  // the chain asks the context too; otherwise `next()` would run the handler, and its send over the first.
  it('ends the chain at a middleware that answered and still called next, under an onSend hook that awaits', async () => {
    let runs = 0
    const slowSend: FastifyPluginAsync = async instance => {
      instance.addHook('onSend', async (_request, _reply, payload) => {
        runs++
        await sleep(20)
        return payload
      })
    }
    const reached: string[] = []

    const app = newApp().with(() => fp(slowSend, { name: 'slow-send' }))
    app.use((ctx, next) => {
      ctx.status(418).body({ answered: 'early' })
      next()
    })
    app.use((_ctx, next) => {
      reached.push('second')
      next()
    })
    await app.bootstrap()

    const res = await app.fetch('/mw/echo')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ answered: 'early' })
    expect(reached).toEqual([])
    expect(runs).toBe(1)
    await app.close()
  })

  it('answers with CORS headers from Node cors() and still runs the handler', async () => {
    const app = newApp()
    app.use(cors({ origin: 'http://example.com' }))
    await app.bootstrap()

    const res = await app.fetch('/mw/echo', { headers: { Origin: 'http://example.com' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://example.com')
    expect(await res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('restricts Node cors() to a path prefix', async () => {
    const app = newApp()
    app.mount(new Router('/api').get('/echo', () => ({ ok: true })))
    app.use('/api', cors({ origin: 'http://example.com' }))
    await app.bootstrap()

    const inside = await app.fetch('/api/echo', { headers: { Origin: 'http://example.com' } })
    const outside = await app.fetch('/mw/echo', { headers: { Origin: 'http://example.com' } })

    expect(inside.status).toBe(200)
    expect(inside.headers.get('access-control-allow-origin')).toBe('http://example.com')
    expect(outside.status).toBe(200)
    expect(outside.headers.get('access-control-allow-origin')).toBeNull()
    await app.close()
  })

  it('refuses a registration after the application is ready', async () => {
    const app = newApp()
    await app.bootstrap()

    expect(() => app.use((_ctx, next) => next())).toThrow(ErrPipelineSealed)
    await app.close()
  })

  it('runs a class at its hinted hook when use() omits { hook }', async () => {
    const order: string[] = []

    class Hinted implements Middleware {
      static get [kMiddlewareHook](): FastifyMiddlewareHook {
        return 'preHandler'
      }

      handle(_ctx: Context, next: Next): void {
        order.push('hinted')
        next()
      }
    }

    const app = newApp(container => {
      container.bind(Hinted, t => t.toClass(Hinted))
    })
    app.use((_ctx, next) => {
      order.push('onRequest')
      next()
    })
    app.use(Hinted)
    await app.bootstrap()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['onRequest', 'hinted'])
    await app.close()
  })

  it('runs a hinted class at onRequest when { hook } overrides the getter', async () => {
    const order: string[] = []

    class Hinted implements Middleware {
      static get [kMiddlewareHook](): FastifyMiddlewareHook {
        return 'preHandler'
      }

      handle(_ctx: Context, next: Next): void {
        order.push('hinted')
        next()
      }
    }

    const app = newApp(container => {
      container.bind(Hinted, t => t.toClass(Hinted))
    })
    app.use(Hinted, { hook: 'onRequest' })
    app.use((_ctx, next) => {
      order.push('second')
      next()
    })
    await app.bootstrap()

    await app.fetch('/mw/echo')

    expect(order).toEqual(['hinted', 'second'])
    await app.close()
  })
})

describe('application middleware registration with a path', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function newPathApp() {
    app = newApp(container => {
      container.bind(Tagger, t => t.toClass(Tagger, [Tag]))
      container.bind(Tag, t => t.toValue(new Tag('injected')))
      container.bind(kTagger, t => t.toValue(new Tagger(new Tag('symbol'))))
      container.bind(stringKey, t => t.toValue(new Tagger(new Tag('string'))))
    })
    return app
  }

  for (const hook of ['onRequest', 'preHandler'] as const) {
    it.each(['function', 'node', 'instance', 'class', 'symbol', 'string', 'factory'] as const)(
      `mounts a %s target with the ${hook} option without affecting sibling paths`,
      async kind => {
        const server = newPathApp()
        const order: string[] = []
        let factoryCalls = 0
        server.mount(
          new Router()
            .get('/api/orders', () => {
              order.push('handler')
              return { ok: true }
            })
            .get('/apiary/orders', () => ({ public: true })),
        )
        const fn: MiddlewareFn = (ctx, next) => {
          ctx.header('x-tag', 'function')
          next()
        }
        const node: NodeMiddleware = (_req, res, next) => {
          res.setHeader('x-tag', 'node')
          next()
        }
        const factory = ({ container }: HTTPSetupContext): Middleware => {
          factoryCalls++
          return new Tagger(container.get(Tag))
        }
        // Keep each target's type intact so the check project verifies the public overloads too.
        switch (kind) {
          case 'function':
            server.use('/api', fn, { hook })
            break
          case 'node':
            server.use('/api', node, { hook })
            break
          case 'instance':
            server.use('/api', new Tagger(new Tag('instance')), { hook })
            break
          case 'class':
            server.use('/api', Tagger, { hook })
            break
          case 'symbol':
            server.use('/api', kTagger, { hook })
            break
          case 'string':
            server.use('/api', stringKey, { hook })
            break
          case 'factory':
            server.useFn('/api', factory, { hook })
            break
        }
        server.use((_ctx, next) => {
          order.push('onRequest')
          next()
        })
        server.use(
          '/api',
          (ctx, next) => {
            order.push(`${hook}:${ctx.req.url}`)
            next()
          },
          { hook },
        )
        await server.bootstrap()

        for (let request = 0; request < 2; request++) {
          order.length = 0
          const response = await server.fetch('/api/orders')
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ ok: true })
          expect(response.headers.get('x-tag')).toBe(
            {
              function: 'function',
              node: 'node',
              instance: 'instance',
              class: 'injected',
              symbol: 'symbol',
              string: 'string',
              factory: 'injected',
            }[kind],
          )
          expect(order).toEqual(['onRequest', `${hook}:/orders`, 'handler'])
        }
        const sibling = await server.fetch('/apiary/orders')
        expect(sibling.status).toBe(200)
        expect(await sibling.json()).toEqual({ public: true })
        expect(sibling.headers.get('x-tag')).toBeNull()
        expect(factoryCalls).toBe(kind === 'factory' ? 1 : 0)
      },
    )
  }

  it.each(['/api', '/api/'])(
    'matches %s at segment boundaries, preserving queries and the handler URL',
    async prefix => {
      const server = newPathApp()
      const seen: string[] = []
      server.mount(new Router().get('/', ctx => ({ url: ctx.req.url })).get('/*', ctx => ({ url: ctx.req.url })))
      server.use(prefix, (ctx, next) => {
        seen.push(ctx.req.url)
        next()
      })
      await server.bootstrap()

      for (const [url, mounted] of [
        ['/api', '/'],
        ['/api/', '/'],
        ['/api?next=/outside', '/?next=/outside'],
        ['/api/orders/42?expand=items', '/orders/42?expand=items'],
        ['/api/hello%20world%2Fitem?q=a%2Fb', '/hello%20world%2Fitem?q=a%2Fb'],
        ['/apiary', undefined],
        ['/api-v2/orders', undefined],
        ['/outside?next=/api', undefined],
        ['/', undefined],
      ] as const) {
        seen.length = 0
        const response = await server.fetch(url)
        expect(response.status, url).toBe(200)
        expect(await response.json(), url).toEqual({ url })
        expect(seen, url).toEqual(mounted === undefined ? [] : [mounted])
      }
    },
  )

  it('runs overlapping array prefixes once and composes mounts against the original URL', async () => {
    const server = newPathApp()
    const seen: string[] = []
    const node: NodeMiddleware = (req, _res, next) => {
      const originalURL = (req as IncomingMessage & { originalUrl: string }).originalUrl
      seen.push(`node:${req.url}:${originalURL}`)
      next()
    }
    server.use(['/api', '/api/orders', '/internal'] as const, node)
    server.use('/api/orders/:id', (ctx, next) => {
      seen.push(`parameter:${ctx.req.url}`)
      next()
    })
    server.use('*', (ctx, next) => {
      seen.push(`global:${ctx.req.url}`)
      next()
    })
    server.mount(
      new Router().get('/*', ctx => {
        seen.push(`handler:${ctx.req.url}`)
        return { ok: true }
      }),
    )
    await server.bootstrap()

    for (const [url, expected] of [
      [
        '/api/orders/a%2Fb/items?q=1',
        ['node:/orders/a%2Fb/items?q=1:/api/orders/a%2Fb/items?q=1', 'parameter:/items?q=1'],
      ],
      ['/internal/jobs', ['node:/jobs:/internal/jobs']],
      ['/internalized/jobs', []],
    ] as const) {
      seen.length = 0
      const response = await server.fetch(url)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(seen).toEqual([...expected, `global:${url}`, `handler:${url}`])
    }
  })

  it('keeps state and mounted URLs isolated while concurrent middleware waits to call next', async () => {
    const server = newPathApp()
    type State = { tenant: string }
    const barrier = Promise.withResolvers<void>()
    let arrivals = 0
    const tenancy: MiddlewareFn<State> = async (ctx, next) => {
      const tenant = ctx.req.header('x-tenant') ?? ''
      ctx.state.set('tenant', tenant)
      if (++arrivals === 2) {
        barrier.resolve()
      }
      await barrier.promise
      ctx.header('x-mounted-url', ctx.req.url)
      next()
    }
    server.use('/tenants/:tenant', tenancy)
    server.mount(
      new Router().vars<State>().get('/tenants/:tenant/orders', ctx => ({
        tenant: ctx.state.get('tenant'),
        url: ctx.req.url,
      })),
    )
    await server.bootstrap()

    const tenants = ['acme', 'globex']
    const responses = await Promise.all(
      tenants.map(tenant =>
        server.fetch(`/tenants/${tenant}/orders?tenant=${tenant}`, { headers: { 'x-tenant': tenant } }),
      ),
    )
    for (const [index, response] of responses.entries()) {
      const tenant = tenants[index]
      expect(response.status).toBe(200)
      expect(response.headers.get('x-mounted-url')).toBe(`/orders?tenant=${tenant}`)
      expect(await response.json()).toEqual({ tenant, url: `/tenants/${tenant}/orders?tenant=${tenant}` })
    }
    expect(arrivals).toBe(2)
  })

  it.each(['next', 'throw', 'reject'] as const)(
    'propagates a mounted middleware failure via %s and keeps subsequent requests usable',
    async mode => {
      const server = newPathApp()
      const reached: string[] = []
      const error = new ErrHTTPForbidden('Access denied')
      const fail: MiddlewareFn = (_ctx, next) => {
        if (mode === 'next') {
          next(error)
          return
        }
        if (mode === 'throw') {
          throw error
        }
        return Promise.reject(error)
      }
      server.use('/private', fail)
      server.use('/private', (_ctx, next) => {
        reached.push('same hook')
        next()
      })
      server.use(
        '/private',
        (_ctx, next) => {
          reached.push('later hook')
          next()
        },
        { hook: 'preHandler' },
      )
      server.mount(
        new Router()
          .get('/private/data', () => {
            reached.push('private handler')
            return { secret: true }
          })
          .get('/public', () => ({ public: true })),
      )
      await server.bootstrap()

      const denied = await server.fetch('/private/data')
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ message: 'Access denied' })
      expect(reached).toEqual([])
      const allowed = await server.fetch('/public')
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toEqual({ public: true })
      expect(reached).toEqual([])
    },
  )

  it.each(['context', 'node'] as const)(
    'stops same-hook middleware, later hooks and the handler after a mounted %s response',
    async kind => {
      const server = newPathApp()
      const reached: string[] = []
      if (kind === 'context') {
        server.use('/private', (ctx, _next) => {
          ctx.status(401).body('blocked')
        })
      } else {
        const deny: NodeMiddleware = (_req, res, _next) => {
          res.statusCode = 401
          res.end('blocked')
        }
        server.use('/private', deny)
      }
      for (const hook of ['onRequest', 'preHandler'] as const) {
        server.use(
          '/private',
          (_ctx, next) => {
            reached.push(hook)
            next()
          },
          { hook },
        )
      }
      server.mount(
        new Router().get('/private/data', () => {
          reached.push('handler')
          return { secret: true }
        }),
      )
      await server.bootstrap()

      const response = await server.fetch('/private/data')
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('blocked')
      expect(reached).toEqual([])
    },
  )
})
