import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import cors from '@fastify/cors'
import { Controller, Get, newHTTP } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '../adapter_factory.js'
import { CORS } from '../decorators/index.js'

describe('CORS', () => {
  describe('global @fastify/cors registration', () => {
    it('adds CORS headers to responses when @fastify/cors is registered with a wildcard origin', async () => {
      @Controller('/cors-global')
      class GlobalCorsController {
        @Get('/resource')
        get() { return { ok: true } }
      }
      void [GlobalCorsController]

      const server = fastify()
      await server.register(cors, { origin: '*' })

      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const res = await server.inject({
        method: 'GET',
        url: '/cors-global/resource',
        headers: { origin: 'https://example.com' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBe('*')
    })

    it('responds to preflight OPTIONS with CORS headers and allowed methods', async () => {
      @Controller('/cors-preflight')
      class PreflightController {
        @Get('/endpoint')
        get() { return {} }
      }
      void [PreflightController]

      const server = fastify()
      await server.register(cors, { origin: 'https://allowed.com', methods: ['GET', 'POST'] })

      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const res = await server.inject({
        method: 'OPTIONS',
        url: '/cors-preflight/endpoint',
        headers: {
          origin: 'https://allowed.com',
          'access-control-request-method': 'GET',
        },
      })

      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://allowed.com')
      expect(res.headers['access-control-allow-methods']).toMatch(/GET/)
    })

    it('does not add CORS headers when @fastify/cors is not registered', async () => {
      @Controller('/no-cors')
      class NoCorsController {
        @Get('/resource')
        get() { return {} }
      }
      void [NoCorsController]

      const server = fastify()
      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const res = await server.inject({
        method: 'GET',
        url: '/no-cors/resource',
        headers: { origin: 'https://example.com' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('@CORS decorator', () => {
    // The adapter places router.binding.tags[kCORS] into each route's config.cors.
    // @fastify/cors v11 reads req.routeOptions.config.cors and merges it with the
    // global options, so per-controller CORS options require no special delegator setup.

    it('overrides the CORS origin for all routes in the decorated controller', async () => {
      @CORS({ origin: 'https://trusted.com' })
      @Controller('/cors-specific')
      class SpecificCorsController {
        @Get('/data')
        get() { return {} }
      }

      @Controller('/cors-default')
      class DefaultCorsController {
        @Get('/data')
        get() { return {} }
      }

      void [SpecificCorsController, DefaultCorsController]

      const server = fastify()
      await server.register(cors, { origin: 'https://global.com' })

      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const resSpecific = await server.inject({
        method: 'GET',
        url: '/cors-specific/data',
        headers: { origin: 'https://trusted.com' },
      })

      const resDefault = await server.inject({
        method: 'GET',
        url: '/cors-default/data',
        headers: { origin: 'https://trusted.com' },
      })

      // @CORS({ origin: 'https://trusted.com' }) overrides the global origin for this controller
      expect(resSpecific.headers['access-control-allow-origin']).toBe('https://trusted.com')
      // No @CORS → falls back to global origin 'https://global.com'
      expect(resDefault.headers['access-control-allow-origin']).toBe('https://global.com')
    })

    it('@CORS(false) disables CORS for the decorated controller while global CORS applies elsewhere', async () => {
      @CORS(false)
      @Controller('/cors-disabled')
      class CorsDisabledController {
        @Get('/resource')
        get() { return {} }
      }

      @Controller('/cors-enabled')
      class CorsEnabledController {
        @Get('/resource')
        get() { return {} }
      }

      void [CorsDisabledController, CorsEnabledController]

      const server = fastify()
      await server.register(cors, { origin: '*' })

      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const resDisabled = await server.inject({
        method: 'GET',
        url: '/cors-disabled/resource',
        headers: { origin: 'https://example.com' },
      })

      const resEnabled = await server.inject({
        method: 'GET',
        url: '/cors-enabled/resource',
        headers: { origin: 'https://example.com' },
      })

      expect(resDisabled.headers['access-control-allow-origin']).toBeUndefined()
      expect(resEnabled.headers['access-control-allow-origin']).toBe('*')
    })

    it('@CORS(false) removes CORS headers from actual requests to that controller', async () => {
      // Note: @fastify/cors reads req.routeOptions.config.cors at request time.
      // For preflight OPTIONS, Fastify may not match the same route config as the
      // actual method (GET/POST), so @CORS(false) only reliably blocks non-preflight requests.
      @CORS(false)
      @Controller('/cors-off-actual')
      class CorsOffActualController {
        @Get('/endpoint')
        get() { return {} }
      }

      @Controller('/cors-on-actual')
      class CorsOnActualController {
        @Get('/endpoint')
        get() { return {} }
      }

      void [CorsOffActualController, CorsOnActualController]

      const server = fastify()
      await server.register(cors, { origin: '*' })

      const app = newHTTP(fastifyAdapterFactory(server))
      await app.ready()

      const resOff = await server.inject({
        method: 'GET',
        url: '/cors-off-actual/endpoint',
        headers: { origin: 'https://example.com' },
      })

      const resOn = await server.inject({
        method: 'GET',
        url: '/cors-on-actual/endpoint',
        headers: { origin: 'https://example.com' },
      })

      expect(resOff.headers['access-control-allow-origin']).toBeUndefined()
      expect(resOn.headers['access-control-allow-origin']).toBe('*')
    })
  })
})
