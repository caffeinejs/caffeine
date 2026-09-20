import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import FastifyCookie, { sign } from '@fastify/cookie'
import fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { cookieConfigSchema, createWebApplication, fastifyAdapterFactory, newRouter } from '../index.js'

const schema = $t.Object({ app: $t.Object({ cookie: cookieConfigSchema }) })

const kConfig = token<InferConfig<typeof schema>>(Symbol('cookie.app.config'))

/**
 * Reading cookies off the context. The cookie feature registers `@fastify/cookie` ahead of every plugin, so an
 * application neither registers it nor has an order to get right — which used to be its job, and used to surface
 * as a bare TypeError when it got it wrong.
 */
describe('ctx.req.cookie()', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { ready(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.ready()

    return app
  }

  /** Reads a cookie from an `onRequest` hook, which is where an authentication scheme reads one. */
  function readsCookieEarly() {
    return () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onRequest', async request => {
            request.httpContext.req.cookie('session')
          })
        },
        { name: 'reads-cookie-early' },
      )
  }

  const routes = () => newRouter('/page').get('/', ctx => ({ session: ctx.req.cookie('session') ?? null }))

  const reads = () => newRouter('/read').get('/', ctx => ({ tok: ctx.req.signedCookie('tok') }))

  async function messageOf(response: Response): Promise<string> {
    return ((await response.json()) as { message: string }).message
  }

  it('reads a cookie with nothing registered by the application', async () => {
    const app = await ready(createWebApplication(fastifyAdapterFactory(fastify())).mount(routes()))

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  it('answers null for a cookie the request did not send', async () => {
    const app = await ready(createWebApplication(fastifyAdapterFactory(fastify())).mount(routes()))

    expect(await (await app.fetch('/page')).json()).toEqual({ session: null })
  })

  // The parsing is in place before any plugin registers, so a hook that runs ahead of the routes sees it too.
  it('has them parsed by the time an onRequest hook reads them', async () => {
    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify())).with(readsCookieEarly()).mount(routes()),
    )

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  it('verifies a signed cookie with the secret the application stated', async () => {
    const secret = 'a-cookie-secret-of-at-least-32-characters'

    const signing = newRouter('/signed').get('/', ctx => {
      ctx.cookie('tok', 'value', { signed: true })

      return { ok: true }
    })

    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify()))
        .cookie(k => k.secret(secret))
        .mount(signing, reads()),
    )

    const issued = (await app.fetch('/signed')).headers.getSetCookie()[0]
    const tok = issued.slice('tok='.length, issued.indexOf(';'))

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${tok}` } })).json()).toEqual({ tok: 'value' })
  })

  // The secret belongs in the environment, so the point of the config node is that it reaches the plugin.
  it('signs with the secret the configuration carries', async () => {
    const secret = 'a-secret-that-came-from-the-configuration'

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { cookie: { secret } } }))
      .build()

    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify()), { config: conf })
        .cookie((k, c) => k.config(c.app.cookie))
        .mount(reads()),
    )

    const response = await app.fetch('/read', { headers: { cookie: `tok=${sign('value', secret)}` } })

    expect(await response.json()).toEqual({ tok: 'value' })
  })

  // A fluent method is the last word: a secret written in code is not a default the tree outranks.
  it('prefers a secret set fluently over the one the configuration carries', async () => {
    const fromConfig = 'a-secret-that-came-from-the-configuration'
    const fromCode = 'a-secret-that-was-written-in-the-code'

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { cookie: { secret: fromConfig } } }))
      .build()

    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify()), { config: conf })
        .cookie((k, c) => k.config(c.app.cookie).secret(fromCode))
        .mount(reads()),
    )

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${sign('value', fromCode)}` } })).json()).toEqual({
      tok: 'value',
    })
    expect(
      await (await app.fetch('/read', { headers: { cookie: `tok=${sign('value', fromConfig)}` } })).json(),
    ).toEqual({ tok: false })
  })

  // The application owns the registration, secret included, so the feature stands down rather than failing the
  // start-up on decorators that are already there.
  it('leaves a server that registered the plugin itself alone', async () => {
    const secret = 'the-secret-the-application-registered-with'
    const server = fastify()
    server.register(FastifyCookie, { secret })

    const app = await ready(createWebApplication(fastifyAdapterFactory(server)).mount(reads()))

    const response = await app.fetch('/read', { headers: { cookie: `tok=${sign('value', secret)}` } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tok: 'value' })
  })

  // Off means unregistered, so a read fails where it is made instead of answering undefined and letting a
  // cookie scheme authenticate nobody.
  it('fails the read when the application turned cookies off', async () => {
    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify()))
        .cookie(k => k.enabled(false))
        .mount(routes()),
    )

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(500)
    expect(await messageOf(response)).toContain('@fastify/cookie plugin is not registered')
  })
})
