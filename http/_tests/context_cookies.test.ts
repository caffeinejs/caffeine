import FastifyCookie from '@fastify/cookie'
import fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, fastifyAdapterFactory, newRouter } from '../index.js'

/**
 * Reading cookies off the context when `@fastify/cookie` is missing, or is there and has not parsed them yet. The
 * two are different mistakes with different fixes, and the second used to surface as a bare TypeError.
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

  async function messageOf(response: Response): Promise<string> {
    return ((await response.json()) as { message: string }).message
  }

  it('says the plugin is not registered when it is not', async () => {
    const app = await ready(createWebApplication(fastifyAdapterFactory(fastify())).mount(routes()))

    const response = await app.fetch('/page')

    expect(response.status).toBe(500)
    expect(await messageOf(response)).toContain('@fastify/cookie plugin is not registered')
  })

  it('says the cookies are not parsed yet when the plugin was registered after whatever reads them', async () => {
    const app = await ready(
      createWebApplication(fastifyAdapterFactory(fastify()))
        .with(readsCookieEarly())
        .with(() => fp(async (instance: FastifyInstance) => instance.register(FastifyCookie), { name: 'late-cookies' }))
        .mount(routes()),
    )

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(500)
    expect(await messageOf(response)).toContain('has not parsed them yet')
  })

  it('reads the cookie when the plugin came first', async () => {
    const server = fastify()
    server.register(FastifyCookie)
    const app = await ready(
      createWebApplication(fastifyAdapterFactory(server)).with(readsCookieEarly()).mount(routes()),
    )

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })
})
