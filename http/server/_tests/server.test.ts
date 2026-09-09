import type { AddressInfo } from 'node:net'

import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, WebApplication, createWebApplication, fastifyAdapterFactory } from '../../index.js'

describe('server builder + run()', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('listens on the configured host with an OS-assigned port when port is left default', async () => {
    @Controller('/srv-configured')
    class ConfiguredController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [ConfiguredController]

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .server(s => s.host('127.0.0.1'))
      .build()

    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  it('falls back to 0.0.0.0 and an OS-assigned port when the server builder is never used', async () => {
    @Controller('/srv-default')
    class DefaultController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [DefaultController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('0.0.0.0')
    expect(address.port).toBeGreaterThan(0)
  })

  it('run() resolves to the bound address, already dial-able on a wildcard bind', async () => {
    @Controller('/srv-info')
    class InfoController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [InfoController]

    // Default build: wildcard host, port 0. The value run() hands back is the one a caller can log or open
    // straight away — no second call, no rebuilding an origin from a wildcard AddressInfo.
    app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    const info = await app.run()

    expect(info.address).toEqual(app.address)
    expect(info.address?.port).toBeGreaterThan(0)
    expect(info.address?.origin).toBe(`http://127.0.0.1:${info.address?.port}`)
  })

  it('run() auto-readies when ready() was not called explicitly', async () => {
    @Controller('/auto')
    class AutoController {
      @Get('/ready')
      ready() {
        return { ready: true }
      }
    }

    void [AutoController]

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .server(s => s.host('127.0.0.1'))
      .build()

    await app.run()

    const res = await app.fetch('/auto/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
  })

  it('binds exactly once when ready() is called explicitly before run()', async () => {
    @Controller('/srv-twice')
    class TwiceController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [TwiceController]

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .server(s => s.host('127.0.0.1'))
      .build()

    await app.ready()
    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })
})
