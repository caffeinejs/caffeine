import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { z } from 'zod'
import { ErrConfigSourceConflict, kAppConfig } from '@caffeinejs/std'
import { CONFIG_REFRESH_LABEL, InlineProvider, type ConfigHandle, type ConfigProvider } from '@caffeinejs/std/config'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../../index.js'
import { kServerOptions, type ServerOptions } from '../index.js'

const schema = z.object({
  server: z.object({ host: z.string(), port: z.coerce.number() }),
  db: z.object({ url: z.string() }),
})

type AppConfig = z.infer<typeof schema>

describe('server builder + config', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('drives the listen address from the application config slice', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c
        .source(new InlineProvider({ server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } })))
      .server(s => s.config(c => c.server))
      .build()

    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  it('throws ErrConfigSourceConflict when both builder options and config are used', async () => {
    const built = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c
        .source(new InlineProvider({ server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } })))
      .server(s => s.port(3000).config(c => c.server))
      .build()

    await expect(built.ready()).rejects.toBeInstanceOf(ErrConfigSourceConflict)
  })

  it('errors clearly when a selector is used without an application config', async () => {
    const built = createWebApplication(fastifyAdapterFactory(fastify()))
      // No `.config(...)` declared — cast bypasses the config-first convention to exercise the runtime guard.
      .server(s => s.config(c => (c as unknown as ConfigHandle<AppConfig>).server))
      .build()

    await expect(built.ready()).rejects.toThrow(/no application config/)
  })

  it('keeps the server address fixed across a config refresh (server is not refresh-aware)', async () => {
    let data = { server: { host: '127.0.0.1', port: 4321 }, db: { url: 'x' } }
    const mutable: ConfigProvider = { id: 'mutable', load: ctx => new InlineProvider(data).load(ctx) }

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c.source(mutable))
      .server(s => s.config(c => c.server))
      .build()

    await app.ready()

    const before = app.container.get<ServerOptions>(kServerOptions)
    expect(before).toEqual({ host: '127.0.0.1', port: 4321 })

    // Refresh the app config to new values...
    data = { server: { host: '0.0.0.0', port: 1234 }, db: { url: 'x' } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // ...the app config sees them, but the server snapshot stays put (the address cannot move once set).
    expect(app.container.get<ConfigHandle<AppConfig>>(kAppConfig).server.port).toBe(1234)
    expect(app.container.get<ServerOptions>(kServerOptions)).toEqual({ host: '127.0.0.1', port: 4321 })
  })

  it('rejects a selector whose slice is not ServerOptions (compile-time)', () => {
    void createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c
        .source(new InlineProvider({ server: { host: 'h', port: 1 }, db: { url: 'u' } })))
      // @ts-expect-error the `db` slice ({ url }) is not assignable to ServerOptions
      .server(s => s.config(c => c.db))
  })
})
