import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import { kServiceConfigure, type Service } from '@caffeinejs/std'
import {
  $p,
  Keys,
  type RouteAuthzOptions,
  type ServiceKit,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'
import { RouteBuilder, registerRouter } from '../decorators/registrar/index.js'

const TEST_SECRET = 'test-secret-key-must-be-at-least-32-chars!!'

function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET))
}

/**
 * Stands in for what a package outside http does: bind its own controller and register its routes during
 * `[kServiceConfigure]`, before `buildRouting` runs.
 */
class ProgrammaticService implements Service {
  readonly #authz: RouteAuthzOptions | undefined
  // A fresh class per service, not a module-level one. `registerRouter` is get-or-create and `routes()` appends,
  // so a shared constructor identity would accumulate a duplicate route for every application built in the
  // process — Fastify then rejects the second registration outright.
  readonly #endpoints = class ProgrammaticEndpoints {
    json() {
      return { ok: true }
    }
  }

  constructor(authz?: RouteAuthzOptions) {
    this.#authz = authz
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    const endpoints = this.#endpoints
    kit.container.bind(endpoints).toValue(new endpoints()).labels(Keys.CONTROLLER)

    const authz = this.#authz
    registerRouter(endpoints, router => {
      const route = new RouteBuilder()
        .path('/programmatic.json')
        .method('GET')
        .handler('json')
        .parameters([$p.context()])

      // Only when protection is actually wanted: `buildRouting` reads *any* defined authz — `{}` included — as
      // decorator protection, and an application with no authentication configured then refuses to start.
      if (authz !== undefined) {
        route.authorize(authz)
      }

      router.path('/').routes([route])
    })

    return Promise.resolve()
  }
}

describe('registerRouter', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('routes a controller bound during [kServiceConfigure]', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.addService(new ProgrammaticService())
    app = builder.build()
    await app.ready()

    const res = await app.fetch('/programmatic.json')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('applies authentication and authorization to the registered route', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addJWTBearer(b => b.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
    builder.addService(new ProgrammaticService({ schemes: ['Bearer'] }))
    app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const anonymous = await app.fetch('/programmatic.json')
    expect(anonymous.status).toBe(401)

    const token = await signToken({ sub: 'user-1' })
    const authenticated = await app.fetch('/programmatic.json', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authenticated.status).toBe(200)
    expect(await authenticated.json()).toEqual({ ok: true })
  })

  it('enforces role requirements on the registered route', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addJWTBearer(b => b.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
    builder.addService(new ProgrammaticService({ roles: ['ops'] }))
    app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const withoutRole = await signToken({ sub: 'user-1' })
    const denied = await app.fetch('/programmatic.json', {
      headers: { authorization: `Bearer ${withoutRole}` },
    })
    expect(denied.status).toBe(403)

    const withRole = await signToken({ sub: 'user-1', roles: ['ops'] })
    const allowed = await app.fetch('/programmatic.json', {
      headers: { authorization: `Bearer ${withRole}` },
    })
    expect(allowed.status).toBe(200)
  })
})
