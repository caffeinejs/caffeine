import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { bindTo } from '../../decorators/bind_to.js'
import { csrf as fastifyCSRF } from '../../platform/fastify/csrf/csrf.js'
import { authentication as fastifyAuthentication } from '../../platform/fastify/security/security.js'
import { HTTPPlugin } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Authentication } from '../security/auth/auth.js'
import { BaseAuthenticationHandler } from '../security/auth/handler.js'
import { AuthenticateResult } from '../security/auth/ticket.js'
import type { FetchAdapterTypes } from './adapter.js'

/** A scheme that authenticates nobody: enough for a gate to be built. */
class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any, any>
type FetchApp = WebApplication<FetchAdapterTypes, any, any, any>

let app: FetchApp | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

describe('the fetch adapter', () => {
  it.each<[string, (app: FetchApp) => unknown, string]>([
    ['.serverCallback(...)', a => a.serverCallback(() => undefined), 'Cannot run ".serverCallback(...)"'],
    [
      'a Fastify plugin factory at the root',
      a => a.with((() => async () => undefined) as never),
      'Cannot install a server plugin',
    ],
    ['a factory that returns nothing', a => a.with((() => undefined) as never), 'Cannot install a server plugin'],
    [
      'a Fastify plugin factory on a router',
      a =>
        a.mount(
          new Router('/r')
            .with((() => async () => undefined) as never)
            .get('/')
            .handler(() => 'r'),
        ),
      'Cannot install a server plugin',
    ],
    [
      'a Node middleware',
      a =>
        a.use(function helmet(_req: unknown, _res: unknown, next: () => void) {
          next()
        } as never),
      'Cannot install the Node middleware "helmet" on the fetch application: it has no Node request',
    ],
  ])('refuses %s at start-up', async (_what, configure, message) => {
    app = createWebApplication()
    configure(app)

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow(message)
  })

  // The engine exports a gate of its own under the same name: the refusal names the import to take.
  it("names the engine's import for the Fastify authentication()", async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .with(fastifyAuthentication() as never)

    await expect(app.bootstrap()).rejects.toThrow('Import "authentication" from "@caffeinejs/http"')
  })

  it("names the engine's import for the Fastify csrf()", async () => {
    app = createWebApplication().with(fastifyCSRF() as never)

    await expect(app.bootstrap()).rejects.toThrow('Import "csrf" from "@caffeinejs/http"')
  })

  // The fetch application has no Node request, but a context middleware needs none.
  it('runs a context middleware, from the application and from a plugin', async () => {
    app = createWebApplication()
      .use((ctx, next) => {
        ctx.header('x-app', '1')
        next()
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register(context: Parameters<HTTPPlugin['register']>[0]): void {
              context.app.use((ctx, next) => {
                ctx.header('x-plugin', '1')
                next()
              })
            }
          })(),
      )
      .mount(new Router('/x').get('/').handler(() => 'x'))
    await app.bootstrap()

    const res = await app.fetch(new Request('http://localhost/x'))

    expect(res.headers.get('x-app')).toBe('1')
    expect(res.headers.get('x-plugin')).toBe('1')
    expect(await res.text()).toBe('x')
  })

  it('throws from app.instance', async () => {
    app = createWebApplication()
    await app.bootstrap()

    expect(() => app!.instance).toThrow('Cannot read the server instance: the fetch application has none')
  })

  it('accepts an HTTPPlugin that mounts a router', async () => {
    app = createWebApplication().with(
      () =>
        new (class extends HTTPPlugin {
          register(context: Parameters<HTTPPlugin['register']>[0]): void {
            context.app.mount(new Router('/mounted').get('/').handler(() => 'mounted'))
          }
        })(),
    )
    await app.bootstrap()

    const res = await app.fetch(new Request('http://localhost/mounted'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mounted')
  })

  it("serves a listener's routes through the listener's fetch", async () => {
    app = createWebApplication()
      .listener('admin')
      .mount(
        new Router('/jobs')
          .extend(bindTo('admin'))
          .get('/')
          .handler(() => 'jobs'),
      )
    await app.bootstrap()

    const res = await app.listeners.get('admin')!.fetch(new Request('http://localhost/jobs'))

    expect(await res.text()).toBe('jobs')
    expect((await app.fetch(new Request('http://localhost/jobs'))).status).toBe(404)
  })
})
