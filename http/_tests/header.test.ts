import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { Controller, Get, Header, MediaType, createWebApplication, fastifyAdapterFactory } from '../index.js'

describe('Header', () => {
  it('applies class-level header to all routes', async () => {
    @Header('x-api-version', '1')
    @Controller('/versioned')
    class VersionedController {
      @Get('/a')
      a() {
        return {}
      }

      @Get('/b')
      b() {
        return {}
      }
    }

    void [VersionedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const resA = await app.fetch('/versioned/a')
    const resB = await app.fetch('/versioned/b')

    expect(resA.headers.get('x-api-version')).toBe('1')
    expect(resB.headers.get('x-api-version')).toBe('1')
  })

  it('applies method-level header only to that route', async () => {
    @Controller('/targeted')
    class TargetedController {
      @Header('x-custom', 'yes')
      @Get('/with-header')
      withHeader() {
        return {}
      }

      @Get('/without-header')
      withoutHeader() {
        return {}
      }
    }

    void [TargetedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const hit = await app.fetch('/targeted/with-header')
    const miss = await app.fetch('/targeted/without-header')

    expect(hit.headers.get('x-custom')).toBe('yes')
    expect(miss.headers.get('x-custom')).toBeNull()
  })

  it('class-level header with array value is sent as multi-value header', async () => {
    @Header('x-roles', ['admin', 'user'])
    @Controller('/multi-class')
    class MultiClassController {
      @Get('/route')
      route() {
        return {}
      }
    }

    void [MultiClassController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/multi-class/route')

    // Fetch Headers joins repeated values with ', ' — the on-the-wire form of a multi-value header.
    expect(res.headers.get('x-roles')).toBe('admin, user')
  })

  it('method-level header with array value is sent as multi-value header', async () => {
    @Controller('/multi-method')
    class MultiMethodController {
      @Header('x-flags', ['read', 'write'])
      @Get('/route')
      route() {
        return {}
      }
    }

    void [MultiMethodController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/multi-method/route')

    expect(res.headers.get('x-flags')).toBe('read, write')
  })

  it('method-level header overrides class-level header with same name', async () => {
    @Header('x-tier', 'class')
    @Controller('/override')
    class OverrideController {
      @Header('x-tier', 'method')
      @Get('/route')
      route() {
        return {}
      }
    }

    void [OverrideController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/override/route')

    expect(res.headers.get('x-tier')).toBe('method')
    expect(res.headers.get('x-tier')).not.toBe(['class', 'method'])
  })

  it('appends "; charset=<charset>" when a charset argument is given', async () => {
    @Controller('/charset')
    class CharsetController {
      @Header('x-media', MediaType.APPLICATION_JSON, 'utf-8')
      @Get('/route')
      route() {
        return {}
      }
    }

    void [CharsetController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/charset/route')

    expect(res.headers.get('x-media')).toBe('application/json; charset=utf-8')
  })

  it('leaves the value unchanged when no charset argument is given', async () => {
    @Controller('/no-charset')
    class NoCharsetController {
      @Header('x-media', MediaType.APPLICATION_JSON)
      @Get('/route')
      route() {
        return {}
      }
    }

    void [NoCharsetController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/no-charset/route')

    expect(res.headers.get('x-media')).toBe('application/json')
  })

  it('appends the charset to each value of an array header', async () => {
    @Controller('/charset-array')
    class CharsetArrayController {
      @Header('x-media-list', ['application/json', 'application/xml'], 'utf-8')
      @Get('/route')
      route() {
        return {}
      }
    }

    void [CharsetArrayController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/charset-array/route')

    expect(res.headers.get('x-media-list')).toBe('application/json; charset=utf-8, application/xml; charset=utf-8')
  })
})
