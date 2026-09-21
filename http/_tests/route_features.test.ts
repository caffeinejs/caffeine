import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrConfiguration, createWebApplication, type AnyRouteExtension, type WebApplication } from '../index.js'
import type { HTTPPluginFactory } from '../plugin.js'
import { newRouter } from '../routing/programmatic/new_router.js'

// What the caching package does to a route and to a server, without the package: a `cache` entry in the route's
// config, and a plugin registered under its name. The start-up check reads nothing else.
const cached: AnyRouteExtension = (target: { config(key: string, value: unknown): unknown }) => {
  target.config('cache', { ttl: 60 })
}

function named(name: string): HTTPPluginFactory {
  return () => {
    const plugin: FastifyPluginAsync = async () => {}

    return fp(plugin, { name })
  }
}

const caching = named('@caffeinejs/caching')

/**
 * A route that declares caching and has no plugin to serve it would answer every request as if the decorator
 * were not there. That is refused at start-up. The plugin may sit on the whole server or on one route group, so
 * the question is asked of each group: a plugin one group installed says nothing about its sibling.
 */
describe('routes that declare caching', () => {
  // Widened: `mount()` re-types the application with the routes it took, and the holder outlives the call.
  let app: WebApplication<any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const pets = () =>
    newRouter('/features-pets')
      .get('/')
      .with(cached)
      .handler(() => ({ ok: true }))

  it('are refused when nothing installed the caching plugin', async () => {
    app = createWebApplication().mount(pets())

    const failure = await app.ready().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message).toContain(
      'Cannot register routes decorated with @CacheControl or @CacheInvalidate: the caching plugin is not installed',
    )
  })

  it('start when the application installed it', async () => {
    app = createWebApplication().with(caching).mount(pets())

    await app.ready()

    expect((await app.fetch('/features-pets')).status).toBe(200)
  })

  it('start when their own group installed it, and a sibling without it is still refused', async () => {
    const served = () =>
      newRouter('/features-served')
        .plugin(caching)
        .get('/')
        .with(cached)
        .handler(() => ({ ok: true }))

    app = createWebApplication().mount(served())
    await app.ready()
    expect((await app.fetch('/features-served')).status).toBe(200)
    await app.close()

    app = createWebApplication().mount(served(), pets())
    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  it('are refused when their group installed some other plugin', async () => {
    const other = newRouter('/features-other')
      .plugin(named('something-else'))
      .get('/')
      .with(cached)
      .handler(() => ({ ok: true }))

    app = createWebApplication().mount(other)

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  it('do not concern a group that declares none', async () => {
    const plain = newRouter('/features-plain')
      .get('/')
      .handler(() => ({ ok: true }))

    app = createWebApplication().mount(plain)
    await app.ready()

    expect((await app.fetch('/features-plain')).status).toBe(200)
  })
})
