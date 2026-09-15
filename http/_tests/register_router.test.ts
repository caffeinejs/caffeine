import {
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type Feature,
  type FeatureConfigureKit,
} from '@caffeinejs/std'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'

import { registerRouteGroup } from '../decorators/registrar/index.js'
import {
  $p,
  Keys,
  type RouteAuthzOptions,
  RouteBuilder,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

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
 * `configure()`, before `buildRouting` runs.
 */
class ProgrammaticService implements Feature {
  readonly #authz: RouteAuthzOptions | undefined
  // A fresh class per service, not a module-level one. `registerRouteGroup` is get-or-create and `routes()` appends,
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

  get [kFeatureName](): string {
    return 'programmatic'
  }

  [kFeatureConfigure](kit: FeatureConfigureKit): Promise<void> {
    const endpoints = this.#endpoints
    kit.container.bind(endpoints, t => t.toValue(new endpoints()).labels(Keys.CONTROLLER))

    const authz = this.#authz
    registerRouteGroup(endpoints, router => {
      const route = new RouteBuilder().path('/programmatic.json').method('GET').name('json').parameters([$p.context()])

      // Only when protection is actually wanted: `buildRouting` reads *any* defined authz — `{}` included — as
      // decorator protection, and an application with no authentication configured then refuses to start.
      if (authz !== undefined) {
        route.authorize(authz)
      }

      router.path('/').routes([route])
    })

    return Promise.resolve()
  }

  [kFeatureBootstrap](): void {
    // Nothing to register.
  }
}

describe('registerRouteGroup', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('routes a controller bound during configure()', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.addFeature(new ProgrammaticService())
    app = builder
    await app.ready()

    const res = await app.fetch('/programmatic.json')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('applies authentication and authorization to the registered route', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addJWTBearer(b => b.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
    builder.addFeature(new ProgrammaticService({ schemes: ['Bearer'] }))
    app = builder
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
    builder.addFeature(new ProgrammaticService({ roles: ['ops'] }))
    app = builder
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
