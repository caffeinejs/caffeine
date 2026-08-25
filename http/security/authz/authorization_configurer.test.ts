import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import {
  Authorize,
  Controller,
  Get,
  Roles,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../index.js'

/**
 * The start-up check that refuses to run an application whose routes are guarded but which registered no way
 * to authenticate anyone.
 *
 * It is the single error that stops a misconfigured application booting, and it had no coverage — a grep for
 * its message across the whole suite returned nothing.
 *
 * Only the failing cases live here. `@Controller` registers into a process-global registry when the class is
 * decorated, and every application built afterwards in the same module sees every controller decorated so
 * far — so an assertion that an application starts *without* the error cannot share a file with controllers
 * that are guarded. Those cases are in `authorization_configurer_open.test.ts`.
 */

describe('authorization without authentication', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close().catch(() => undefined)
      app = undefined
    }
  })

  it('refuses to start when a route is protected and no scheme is registered', async () => {
    @Controller('/authz-no-auth')
    class NoAuthController {
      @Get('/')
      @Authorize()
      list() {
        return { ok: true }
      }
    }
    void [NoAuthController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build() as WebApplication

    await expect(app.ready())
      .rejects.toThrow('Cannot start application: authorization is configured but authentication is not')
    app = undefined
  })

  it('refuses to start for a controller-level guard too', async () => {
    @Authorize()
    @Controller('/authz-no-auth-class')
    class NoAuthClassController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [NoAuthClassController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build() as WebApplication

    await expect(app.ready()).rejects.toThrow('authorization is configured but authentication is not')
    app = undefined
  })

  it('refuses to start for @Roles, which is a guard like any other', async () => {
    @Controller('/authz-no-auth-roles')
    class NoAuthRolesController {
      @Get('/')
      @Roles('admin')
      list() {
        return { ok: true }
      }
    }
    void [NoAuthRolesController]

    app = createWebApplication(fastifyAdapterFactory(fastify())).build() as WebApplication

    await expect(app.ready()).rejects.toThrow('authorization is configured but authentication is not')
    app = undefined
  })
})
