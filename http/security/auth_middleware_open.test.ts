import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AllowAnonymous,
  Controller,
  Get,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

/**
 * The other half of the authentication middleware's start-up check: applications that must NOT be refused.
 *
 * Nothing here registers the middleware, and nothing here needs to — an application with no guarded route
 * has nothing for it to guard.
 *
 * A separate file because `@Controller` registers into a process-global registry at decoration time, so every
 * application built in a module sees every controller that module has decorated. A test asserting "this app
 * starts" therefore cannot sit beside one that decorates a guarded controller — the guarded one leaks in and
 * trips the check. Vitest isolates modules per file, which is what keeps these two apps clean.
 */

describe('applications that are not refused at start-up', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close().catch(() => undefined)
      app = undefined
    }
  })

  it('starts when nothing is guarded', async () => {
    @Controller('/authz-open')
    class OpenController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpenController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build() as WebApplication
    await app.ready()

    expect((await app.fetch('/authz-open')).status).toBe(200)
  })

  // `hasProtection` is `hasDecoratorProtection && !isAnonymous`, so a decorator that only opts *out* is not
  // protection and must not demand an authentication scheme.
  it('starts when the only authz decorator is @AllowAnonymous', async () => {
    @Controller('/authz-anon-only')
    class AnonOnlyController {
      @Get('/')
      @AllowAnonymous()
      list() {
        return { ok: true }
      }
    }
    void [AnonOnlyController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build() as WebApplication
    await app.ready()

    expect((await app.fetch('/authz-anon-only')).status).toBe(200)
  })
})
