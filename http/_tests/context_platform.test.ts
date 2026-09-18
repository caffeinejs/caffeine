import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { Context } from '../context.js'
import { createWebApplication, fastifyAdapterFactory, type WebApplication } from '../index.js'
import { Responder, type ActionResult } from '../response.js'
import { Router } from '../routing/programmatic/router.js'

/** What a reader holding only a `Context` finds on `ctx.platform`, as plain values a response can carry. */
function describePlatform(ctx: Context): { name: string; ownRequest: boolean; ownReply: boolean } {
  return {
    name: ctx.platform.name,
    ownRequest: ctx.platform.request.raw === ctx.req.raw,
    ownReply: ctx.platform.reply.request === ctx.platform.request,
  }
}

class PlatformResponder extends Responder {
  respond(ctx: Context): ActionResult {
    return describePlatform(ctx)
  }
}

describe('ctx.platform', () => {
  let app: WebApplication<any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The escape hatch is for code that holds only a `Context` and needs what Fastify, or a Fastify plugin, added. So
  // it is read from each place such code lives — a handler, a middleware, a `Responder` — and must be the request
  // and reply Fastify is serving there, not some other pair.
  it('is the request and reply Fastify is serving, wherever a context is read', async () => {
    let fromMiddleware: ReturnType<typeof describePlatform> | undefined

    const router = new Router('/platform')
      .get('/handler', ctx => describePlatform(ctx))
      .get('/responder', () => new PlatformResponder())

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      container: new CaffeineIoC({ decorators: false }),
    })
      .use((ctx, next) => {
        fromMiddleware = describePlatform(ctx)
        next()
      })
      .mount(router)

    await app.ready()

    const expected = { name: 'fastify', ownRequest: true, ownReply: true }

    expect(await (await app.fetch('/platform/handler')).json()).toEqual(expected)
    expect(await (await app.fetch('/platform/responder')).json()).toEqual(expected)
    expect(fromMiddleware).toEqual(expected)
  })
})
