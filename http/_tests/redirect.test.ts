import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { $p } from '../core/routing/picker.js'
import { type IContext, Controller, Get, Header, Args, Post } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

describe('Redirect', () => {
  describe('given a router with different redirect strategies', () => {
    @Controller('/redirect')
    class RedirectController {
      @Get('/')
      @Args([$p.context()])
      get(ctx: IContext) {
        ctx.redirect('/foo')
      }

      @Post('/test')
      @Header('x-test', 'tested')
      post() {
        return Response.redirect(new URL('/another-place', 'http://localhost').href, 307)
      }
    }

    void [RedirectController]

    const app = createWebApplication()

    beforeAll(async () => {
      await app.bootstrap()
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
      const res = await app.fetch('/redirect/test', { method: 'POST' })

      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('http://localhost/another-place')
      expect(res.headers.get('x-test')).toBe('tested')
    })
  })
})
