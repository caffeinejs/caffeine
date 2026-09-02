import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import {
  Controller,
  Get,
  Router,
  RouteBuilder,
  RouteGroupBuilder,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import type { ServiceAPI } from '@caffeinejs/std'
import { CORS, CorsBuilder, cors, CORSExt } from '../index.js'

function corsApp(configure: (c: ServiceAPI<CorsBuilder>) => void) {
  return createWebApplication(fastifyAdapterFactory(fastify()), {})
    .extend(CORSExt, configure)
}

describe('CORS', () => {
  describe('global CORSExt registration', () => {
    it('adds CORS headers to responses when CORS is activated with a wildcard origin', async () => {
      @Controller('/cors-global')
      class GlobalCorsController {
        @Get('/resource')
        get() { return { ok: true } }
      }
      void [GlobalCorsController]

      const app = corsApp(c => c.options({ origin: '*' })).build()
      await app.ready()

      const res = await app.fetch('/cors-global/resource', { headers: { origin: 'https://example.com' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('responds to preflight OPTIONS with CORS headers and allowed methods', async () => {
      @Controller('/cors-preflight')
      class PreflightController {
        @Get('/endpoint')
        get() { return {} }
      }
      void [PreflightController]

      const app = corsApp(c => c.options({ origin: 'https://allowed.com', methods: ['GET', 'POST'] })).build()
      await app.ready()

      const res = await app.fetch('/cors-preflight/endpoint', { method: 'OPTIONS', headers: {
        origin: 'https://allowed.com',
        'access-control-request-method': 'GET',
      } })

      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('https://allowed.com')
      expect(res.headers.get('access-control-allow-methods')).toMatch(/GET/)
    })

    it('does not add CORS headers when CORSExt is not activated', async () => {
      @Controller('/no-cors')
      class NoCorsController {
        @Get('/resource')
        get() { return {} }
      }
      void [NoCorsController]

      const app = createWebApplication(fastifyAdapterFactory(fastify()), {}).build()
      await app.ready()

      const res = await app.fetch('/no-cors/resource', { headers: { origin: 'https://example.com' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('@CORS decorator', () => {
    // cors() writes config.cors. @fastify/cors v11 reads req.routeOptions.config.cors and
    // merges it with the global options, so per-controller CORS options require no special
    // delegator setup.

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

      const app = corsApp(c => c.options({ origin: 'https://global.com' })).build()
      await app.ready()

      const resSpecific = await app.fetch('/cors-specific/data', { headers: { origin: 'https://trusted.com' } })

      const resDefault = await app.fetch('/cors-default/data', { headers: { origin: 'https://trusted.com' } })

      // @CORS({ origin: 'https://trusted.com' }) overrides the global origin for this controller
      expect(resSpecific.headers.get('access-control-allow-origin')).toBe('https://trusted.com')
      // No @CORS → falls back to global origin 'https://global.com'
      expect(resDefault.headers.get('access-control-allow-origin')).toBe('https://global.com')
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

      const app = corsApp(c => c.options({ origin: '*' })).build()
      await app.ready()

      const resDisabled = await app.fetch('/cors-disabled/resource', { headers: { origin: 'https://example.com' } })

      const resEnabled = await app.fetch('/cors-enabled/resource', { headers: { origin: 'https://example.com' } })

      expect(resDisabled.headers.get('access-control-allow-origin')).toBeNull()
      expect(resEnabled.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('@CORS(false) removes CORS headers from actual requests to that controller', async () => {
      // @fastify/cors reads req.routeOptions.config.cors at request time.
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

      const app = corsApp(c => c.options({ origin: '*' })).build()
      await app.ready()

      const resOff = await app.fetch('/cors-off-actual/endpoint', { headers: { origin: 'https://example.com' } })

      const resOn = await app.fetch('/cors-on-actual/endpoint', { headers: { origin: 'https://example.com' } })

      expect(resOff.headers.get('access-control-allow-origin')).toBeNull()
      expect(resOn.headers.get('access-control-allow-origin')).toBe('*')
    })
  })

  describe('cors() extension', () => {
    it('writes the same spec as an equivalent config.cors assignment', () => {
      const viaExtension = new RouteBuilder()
      cors({ origin: 'https://trusted.com' })(viaExtension)

      const viaConfig = new RouteBuilder()
      viaConfig.config('cors', { origin: 'https://trusted.com' })

      expect(viaExtension.toRoute().config).toEqual(viaConfig.toRoute().config)
    })

    it('applies at group level too', () => {
      const group = new RouteGroupBuilder()
      cors({ origin: 'https://trusted.com' })(group)

      expect(group.toRouteGroup().config?.get('cors')).toEqual({ origin: 'https://trusted.com' })
    })

    it('overrides the global origin on a programmatic route', async () => {
      const specific = new Router('/cors-fluent-specific')
      specific.get('/data').with(cors({ origin: 'https://trusted.com' })).handler(() => ({}))

      const fallback = new Router('/cors-fluent-default')
      fallback.get('/data').handler(() => ({}))

      const app = corsApp(c => c.options({ origin: 'https://global.com' })).build().mount(specific, fallback)
      await app.ready()

      const resSpecific = await app.fetch('/cors-fluent-specific/data', {
        headers: { origin: 'https://trusted.com' },
      })
      const resDefault = await app.fetch('/cors-fluent-default/data', {
        headers: { origin: 'https://trusted.com' },
      })

      expect(resSpecific.headers.get('access-control-allow-origin')).toBe('https://trusted.com')
      expect(resDefault.headers.get('access-control-allow-origin')).toBe('https://global.com')
    })
  })
})
