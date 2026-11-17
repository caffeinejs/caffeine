import { Injectable } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ActionResult,
  Catch,
  type IContext,
  ErrHTTPBadRequest,
  type ErrorHandler,
  type Guard,
  type GuardInput,
  Guards,
  HTTPPlugin,
  type HTTPSetupContext,
  type ListenerConfigurer,
  bindTo,
  type WebApplication,
  Router,
} from '../../../index.js'
import { createWebApplication, type NodeServerSettings } from '../../../platform/node/index.js'

/**
 * Scenario: routers on a listener with middleware, guards and plugins.
 *
 * What a router asks for itself — `router.with(...)` and `router.guards(...)`, the counterparts of `@Use(...)` and
 * `@UseGuards(...)` — follows the router to whichever server serves it, nested routers included. What a server
 * registers for itself is `plugins.test.ts`'s.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** A plugin marking every response it covers with `header`: a value already there is kept, this one appended. */
class Marking extends HTTPPlugin {
  override readonly name: string
  readonly #header: string
  readonly #value: string

  constructor(header: string, value = 'yes') {
    super()
    this.#header = header
    this.#value = value
    this.name = `marking:${header}:${value}`
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onRequest', ctx => {
      const previous = ctx.getHeader(this.#header)
      ctx.header(this.#header, previous === undefined ? this.#value : `${String(previous)},${this.#value}`)
    })
  }
}

/** A plugin marking every response it covers with `header`. */
function marking(header: string, value = 'yes') {
  return () => new Marking(header, value)
}

@Injectable()
class DenyGuard implements Guard {
  guard(): boolean {
    return false
  }
}

@Injectable()
class TokenGuard implements Guard {
  guard(input: GuardInput): boolean {
    return input.context.req.header('x-token') === 'ok'
  }
}

class Teapot extends Error {}

@Catch(Teapot)
class TeapotHandler implements ErrorHandler<Teapot> {
  handle(ctx: IContext): ActionResult {
    return ctx.status(418).body({ teapot: true })
  }
}

void [DenyGuard, TokenGuard, TeapotHandler]

describe('routers on a listener with middleware, guards and plugins', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  const admin: ListenerConfigurer<unknown, NodeServerSettings> = l => l.server(() => ({ listen: listener }))

  function at(server: 'main' | 'admin', path: string, headers?: Record<string, string>): Promise<Response> {
    const origin = server === 'main' ? app!.address!.origin : app!.listeners.get('admin')!.address!.origin
    return fetch(`${origin}${path}`, { headers })
  }

  it("runs a router's own plugin on what it serves on the listener, and nowhere else", async () => {
    app = createWebApplication()
      .listener('admin', admin)
      .server(() => ({ listen: listener }))
      .mount(
        new Router('/jobs')
          .extend(bindTo('admin'))
          .with(marking('x-router-plugin'))
          .get('/', () => ({ jobs: true })),
        new Router('/api').get('/', () => ({ api: true })),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/jobs')).headers.get('x-router-plugin')).toBe('yes')
    expect((await at('main', '/api')).headers.get('x-router-plugin')).toBeNull()
  })

  it("denies with the router's own guards on the listener, and runs the global guards there too", async () => {
    app = createWebApplication()
      .listener('admin', admin)
      .install(Guards(g => g.global(TokenGuard)))
      .mount(
        new Router('/denied')
          .extend(bindTo('admin'))
          .guards([DenyGuard])
          .get('/', () => ({ denied: false })),
        new Router('/open').extend(bindTo('admin')).get('/', () => ({ open: true })),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/denied', { 'x-token': 'ok' })).status).toBe(403)
    expect((await at('admin', '/open')).status).toBe(403)
    expect((await at('admin', '/open', { 'x-token': 'ok' })).status).toBe(200)
  })

  it('carries the binding, the plugin and the guards of a router down to the routers nested in it', async () => {
    app = createWebApplication()
      .listener('admin', admin)
      .server(() => ({ listen: listener }))
      .mount(
        new Router('/ops')
          .extend(bindTo('admin'))
          .with(marking('x-parent-plugin'))
          .guards([TokenGuard])
          .group('/child', child => child.get('/', () => ({ child: true }))),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/ops/child')).status).toBe(403)

    const allowed = await at('admin', '/ops/child', { 'x-token': 'ok' })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('x-parent-plugin')).toBe('yes')

    expect((await at('main', '/ops/child', { 'x-token': 'ok' })).status).toBe(404)
  })

  it("answers on the listener with the application's error handlers and its not-found problem", async () => {
    app = createWebApplication()
      .listener('admin', admin)
      .server(() => ({ listen: listener }))
      .errorHandling(e => e.globalHandlers(TeapotHandler))
      .mount(
        new Router('/failing')
          .extend(bindTo('admin'))
          .get('/teapot', () => {
            throw new Teapot()
          })
          .get('/bad', () => {
            throw new ErrHTTPBadRequest('bad input')
          }),
        new Router('/failing-main').get('/bad', () => {
          throw new ErrHTTPBadRequest('bad input')
        }),
      ) as WebApplication

    await app.run()

    const teapot = await at('admin', '/failing/teapot')
    expect(teapot.status).toBe(418)
    expect(await teapot.json()).toEqual({ teapot: true })

    const bad = await at('admin', '/failing/bad')
    const badOnMain = await at('main', '/failing-main/bad')
    expect(bad.status).toBe(400)
    // Each answer carries its own request ID and time; the rest is the same.
    expect(unstamped(await bad.json())).toEqual(unstamped(await badOnMain.json()))

    const missing = await at('admin', '/nothing-here')
    const missingOnMain = await at('main', '/nothing-here')
    expect(missing.status).toBe(404)
    expect(unstamped(await missing.json())).toEqual(unstamped(await missingOnMain.json()))
  })
})

function unstamped(problem: unknown): Record<string, unknown> {
  const { correlation_id: _id, timestamp: _at, ...rest } = problem as Record<string, unknown>
  return rest
}
