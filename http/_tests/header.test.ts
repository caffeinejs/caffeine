import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, Header, createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '../adapter_factory.js'

describe('Header', () => {
  it('applies class-level header to all routes', async () => {
    @Header('x-api-version', '1')
    @Controller('/versioned')
    class VersionedController {
      @Get('/a')
      a() { return {} }

      @Get('/b')
      b() { return {} }
    }

    void [VersionedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const resA = await app.instance.inject({ method: 'GET', url: '/versioned/a' })
    const resB = await app.instance.inject({ method: 'GET', url: '/versioned/b' })

    expect(resA.headers['x-api-version']).toBe('1')
    expect(resB.headers['x-api-version']).toBe('1')
  })

  it('applies method-level header only to that route', async () => {
    @Controller('/targeted')
    class TargetedController {
      @Header('x-custom', 'yes')
      @Get('/with-header')
      withHeader() { return {} }

      @Get('/without-header')
      withoutHeader() { return {} }
    }

    void [TargetedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const hit = await app.instance.inject({ method: 'GET', url: '/targeted/with-header' })
    const miss = await app.instance.inject({ method: 'GET', url: '/targeted/without-header' })

    expect(hit.headers['x-custom']).toBe('yes')
    expect(miss.headers['x-custom']).toBeUndefined()
  })

  it('class-level header with array value is sent as multi-value header', async () => {
    @Header('x-roles', ['admin', 'user'])
    @Controller('/multi-class')
    class MultiClassController {
      @Get('/route')
      route() { return {} }
    }

    void [MultiClassController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/multi-class/route' })

    expect(res.headers['x-roles']).toEqual(['admin', 'user'])
  })

  it('method-level header with array value is sent as multi-value header', async () => {
    @Controller('/multi-method')
    class MultiMethodController {
      @Header('x-flags', ['read', 'write'])
      @Get('/route')
      route() { return {} }
    }

    void [MultiMethodController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/multi-method/route' })

    expect(res.headers['x-flags']).toEqual(['read', 'write'])
  })

  it('method-level header overrides class-level header with same name', async () => {
    @Header('x-tier', 'class')
    @Controller('/override')
    class OverrideController {
      @Header('x-tier', 'method')
      @Get('/route')
      route() { return {} }
    }

    void [OverrideController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/override/route' })

    expect(res.headers['x-tier']).toBe('method')
    expect(res.headers['x-tier']).not.toBe(['class', 'method'])
  })
})
