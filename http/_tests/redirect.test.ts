import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { type Context, Controller, Get, Header, createWebApplication, Params, Post, fastifyAdapterFactory } from '../index.js'
import { $p } from '../route_picker.js'

describe('Redirect', () => {
  describe('given a router with different redirect strategies', () => {
    @Controller('/redirect')
    class RedirectController {
      @Get('/')
      @Params([$p.context()])
      get(ctx: Context) {
        ctx.redirect('/foo')
      }

      @Post('/test')
      @Header('x-test', 'tested')
      post() {
        return Response.redirect(new URL('/another-place', 'http://localhost'), 307)
      }
    }

    void [RedirectController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    beforeAll(async () => {
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    it('should redirect to the given location', async () => {
      const res = await app.fetch('/redirect')

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/foo')
    })

    it('should redirect to the given location with the given response specification', async () => {
      const res = await app.fetch ('/redirect/test', { method: 'POST' })

      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('http://localhost/another-place')
      expect(res.headers.get('x-test')).toBe('tested')
    })
  })
})
