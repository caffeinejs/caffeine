import {
  ErrInvalidDecorator,
  Injectable,
  Lifetime,
  Scopes,
  defineMetadata,
  getMetadataOverride,
  token,
} from '@caffeinejs/di'
import fastify, { type FastifyContextConfig, type RouteOptions } from 'fastify'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import {
  Catch,
  Claim,
  Controller,
  ErrConfiguration,
  ErrHTTPUnauthorized,
  ErrorHandler,
  Get,
  Guard,
  Identity,
  Post,
  Principal,
  UseGuards,
  createWebApplication,
  fastifyAdapterFactory,
  type ActionResult,
  type Context,
  type GuardResult,
  type WebApplication,
} from '../index.js'
import type { GuardInput } from './guard.js'

function buildApp() {
  return createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
}

describe('guard', () => {
  @Injectable()
  class AllowGuard implements Guard {
    guard(): boolean {
      return true
    }
  }

  @Injectable()
  class DenyGuard implements Guard {
    guard(): boolean {
      return false
    }
  }

  @Injectable()
  class ResultAllowGuard implements Guard {
    guard(): GuardResult {
      return { ok: true, reason: 'ignored' }
    }
  }

  @Injectable()
  class ResultDenyGuard implements Guard {
    guard(): GuardResult {
      return { ok: false, reason: 'nope' }
    }
  }

  @Injectable()
  class AsyncAllowGuard implements Guard {
    guard(): Promise<boolean> {
      return Promise.resolve(true)
    }
  }

  @Injectable()
  class AsyncDenyGuard implements Guard {
    guard(): Promise<boolean> {
      return Promise.resolve(false)
    }
  }

  @Injectable()
  class AsyncResultDenyGuard implements Guard {
    guard(): Promise<GuardResult> {
      return Promise.resolve({ ok: false, reason: 'later' })
    }
  }

  @Controller('/guard-allow')
  class AllowController {
    @UseGuards(AllowGuard)
    @Get('/')
    ok() {
      return { ok: true }
    }

    @UseGuards(ResultAllowGuard)
    @Get('/result')
    resultOk() {
      return { ok: true }
    }

    @UseGuards(AsyncAllowGuard)
    @Get('/async')
    asyncOk() {
      return { ok: true }
    }
  }

  @Controller('/guard-deny')
  class DenyController {
    @UseGuards(DenyGuard)
    @Get('/')
    never() {
      return { ok: true }
    }

    @UseGuards(ResultDenyGuard)
    @Get('/result')
    resultNever() {
      return { ok: true }
    }

    @UseGuards(AsyncDenyGuard)
    @Get('/async')
    asyncNever() {
      return { ok: true }
    }

    @UseGuards(AsyncResultDenyGuard)
    @Get('/async-result')
    asyncResultNever() {
      return { ok: true }
    }
  }

  void [
    AllowGuard,
    DenyGuard,
    ResultAllowGuard,
    ResultDenyGuard,
    AsyncAllowGuard,
    AsyncDenyGuard,
    AsyncResultDenyGuard,
    AllowController,
    DenyController,
  ]

  it('allows a boolean true', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-allow')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await built.close()
  })

  it('allows GuardResult.ok true and ignores reason', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-allow/result')
    expect(res.status).toBe(200)

    await built.close()
  })

  it('allows a Promise of true', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-allow/async')
    expect(res.status).toBe(200)

    await built.close()
  })

  it('denies a boolean false', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-deny')
    expect(res.status).toBe(403)

    await built.close()
  })

  it('denies GuardResult.ok false', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-deny/result')
    expect(res.status).toBe(403)

    await built.close()
  })

  it('denies a Promise of false', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-deny/async')
    expect(res.status).toBe(403)

    await built.close()
  })

  it('denies a Promise of GuardResult.ok false', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/guard-deny/async-result')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ message: 'later' })

    await built.close()
  })
})

describe('use_guards', () => {
  const order: string[] = []

  @Injectable()
  class GlobalGuard implements Guard {
    guard(): boolean {
      order.push('global')
      return true
    }
  }

  @Injectable()
  class ControllerGuard implements Guard {
    guard(): boolean {
      order.push('controller')
      return true
    }
  }

  @Injectable()
  class MethodGuard implements Guard {
    guard(): boolean {
      order.push('method')
      return true
    }
  }

  @Injectable()
  class FirstGuard implements Guard {
    guard(): boolean {
      order.push('first')
      return true
    }
  }

  @Injectable()
  class OrderedDenyGuard implements Guard {
    guard(): boolean {
      order.push('deny')
      return false
    }
  }

  @Injectable()
  class UnreachedGuard implements Guard {
    guard(): boolean {
      order.push('unreached')
      return true
    }
  }

  @UseGuards(ControllerGuard)
  @Controller('/use-guards')
  class UseGuardsController {
    @UseGuards(MethodGuard)
    @Get('/both')
    both() {
      return { ok: true }
    }
  }

  @Controller('/use-guards-multi')
  class UseGuardsMultiController {
    @UseGuards(FirstGuard, OrderedDenyGuard, UnreachedGuard)
    @Get('/multi')
    multi() {
      return { ok: true }
    }
  }

  void [
    GlobalGuard,
    ControllerGuard,
    MethodGuard,
    FirstGuard,
    OrderedDenyGuard,
    UnreachedGuard,
    UseGuardsController,
    UseGuardsMultiController,
  ]

  it('runs global, then controller, then method', async () => {
    order.length = 0
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .guards(g => g.global(GlobalGuard))
      .build()
    await app.ready()

    const res = await app.fetch('/use-guards/both')
    expect(res.status).toBe(200)
    expect(order).toEqual(['global', 'controller', 'method'])

    await app.close()
  })

  it('runs multiple method guards in declaration order and stops at the first denial', async () => {
    order.length = 0
    const app = buildApp()
    await app.ready()

    const res = await app.fetch('/use-guards-multi/multi')
    expect(res.status).toBe(403)
    expect(order).toEqual(['first', 'deny'])

    await app.close()
  })

  it('rejects an empty @UseGuards() at decoration time', () => {
    expect(() => UseGuards()).toThrow(ErrInvalidDecorator)
  })
})

describe('builder', () => {
  @Injectable()
  class ListedGuard implements Guard {
    guard(): boolean {
      return true
    }
  }

  @Injectable()
  class NotAGuard {
    ping() {
      return true
    }
  }

  @Controller('/builder-ok')
  class BuilderOkController {
    @Get('/')
    ok() {
      return { ok: true }
    }
  }

  @Controller('/builder-use')
  class BuilderUseController {
    @UseGuards(ListedGuard)
    @Get('/')
    ok() {
      return { ok: true }
    }
  }

  void [ListedGuard, NotAGuard, BuilderOkController, BuilderUseController]

  it('runs a global guard listed by InjectionToken on every route', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .guards(g => g.global(ListedGuard))
      .build()
    await app.ready()

    const res = await app.fetch('/builder-ok')
    expect(res.status).toBe(200)

    await app.close()
  })

  it('does not require .guards() for @UseGuards on a controller', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.fetch('/builder-use')
    expect(res.status).toBe(200)

    await app.close()
  })

  it('rejects a missing InjectionToken at start-up', async () => {
    const kMissing = token<Guard>(Symbol('missing-guard'))
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .guards(g => g.global(kMissing))
      .build()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  it('rejects a InjectionToken that is not a Guard at start-up', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .guards(g => g.global(NotAGuard as never))
      .build()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})

describe('denial', () => {
  @Injectable()
  class FalseGuard implements Guard {
    guard(): boolean {
      return false
    }
  }

  @Injectable()
  class ReasonGuard implements Guard {
    guard(): GuardResult {
      return { ok: false, reason: 'token expired' }
    }
  }

  @Injectable()
  class UnauthorizedGuard implements Guard {
    guard(): never {
      throw new ErrHTTPUnauthorized()
    }
  }

  @Catch(ErrHTTPUnauthorized)
  class UnauthorizedCatch extends ErrorHandler<ErrHTTPUnauthorized> {
    handle(ctx: Context, error: ErrHTTPUnauthorized): ActionResult {
      ctx.status(401)
      return { caught: true, message: error.message }
    }
  }

  @Controller('/denial')
  class DenialController {
    @UseGuards(FalseGuard)
    @Get('/false')
    byFalse() {
      return { ok: true }
    }

    @UseGuards(ReasonGuard)
    @Get('/reason')
    byReason() {
      return { ok: true }
    }

    @UseGuards(UnauthorizedGuard)
    @Get('/401')
    byThrow() {
      return { ok: true }
    }
  }

  void [FalseGuard, ReasonGuard, UnauthorizedGuard, UnauthorizedCatch, DenialController]

  it('renders the Nest-similar 403 envelope for boolean false', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/denial/false')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'ERR_HTTP_FORBIDDEN',
      message: 'Resource forbidden',
    })

    await built.close()
  })

  it('adds reason on GuardResult denial and keeps the stable message', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/denial/reason')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'ERR_HTTP_FORBIDDEN',
      message: 'token expired',
    })

    await built.close()
  })

  it('lets a thrown ErrHTTPUnauthorized reach @Catch', async () => {
    const built = buildApp()
    await built.ready()

    const res = await built.fetch('/denial/401')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ caught: true, message: 'Unauthorized' })

    await built.close()
  })
})

describe('on_request', () => {
  @Injectable()
  class HeaderGuard implements Guard {
    guard(input: GuardInput): boolean {
      // `body` is off the guard's view of the request by type; reached through a cast, it answers undefined,
      // which is the point: the guard runs before the body has been parsed.
      return (
        (input.context.req as { body?: () => unknown }).body!() === undefined &&
        input.context.req.header('x-token') === 'ok'
      )
    }
  }

  @Controller('/on-request')
  class OnRequestController {
    @UseGuards(HeaderGuard)
    @Post('/echo')
    echo() {
      return { ok: true }
    }

    @UseGuards(HeaderGuard)
    @Get('/ping')
    ping() {
      return { ok: true }
    }
  }

  void [HeaderGuard, OnRequestController]

  it('runs before the body is parsed and can read headers', async () => {
    const app = buildApp()
    await app.ready()

    const denied = await app.fetch('/on-request/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 1 }),
    })
    expect(denied.status).toBe(403)

    const allowed = await app.fetch('/on-request/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': 'ok' },
      body: JSON.stringify({ secret: 1 }),
    })
    expect(allowed.status).toBe(200)

    await app.close()
  })
})

describe('target', () => {
  let seen: GuardInput['target'] | undefined

  @Injectable()
  class RecordingGuard implements Guard {
    guard(input: GuardInput): boolean {
      seen = input.target
      return true
    }
  }

  @Controller('/target')
  class TargetController {
    @UseGuards(RecordingGuard)
    @Get('/one')
    one() {
      return { ok: true }
    }
  }

  void [RecordingGuard, TargetController]

  it('names the class and the handler the guard is running for', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.fetch('/target/one')
    expect(res.status).toBe(200)
    expect(seen?.clazz).toBe(TargetController)
    expect(seen?.handler).toBe('one')

    await app.close()
  })
})

describe('authorization', () => {
  enum Role {
    User = 'user',
    Admin = 'admin',
  }

  const kRoles = Symbol('roles')

  function Roles(...roles: Role[]) {
    return (_target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
      defineMetadata(context, kRoles, roles)
    }
  }

  const users: Record<string, Role[]> = {
    user: [Role.User],
    admin: [Role.Admin],
  }

  @Injectable()
  class AuthGuard implements Guard {
    guard(input: GuardInput): boolean {
      const header = input.context.req.header('authorization')
      if (header == null || !header.startsWith('Bearer ')) {
        throw new ErrHTTPUnauthorized()
      }

      const token = header.slice('Bearer '.length)
      const roles = users[token]
      if (roles === undefined) {
        throw new ErrHTTPUnauthorized()
      }

      input.context.user = new Principal(true, new Identity('test', true, [new Claim('roles', roles, 'test')]))

      return true
    }
  }

  @Injectable()
  class RolesGuard implements Guard {
    guard(input: GuardInput): boolean {
      const cfg = input.context.routeConfig as FastifyContextConfig
      const required = getMetadataOverride<Role[]>(
        cfg.caffeine?.target as Function,
        kRoles,
        cfg.caffeine?.handler as string | symbol,
      )

      if (required === undefined) {
        return true
      }

      return required.some(role => input.context.user.isInRole(role))
    }
  }

  @Controller('/cats')
  class CatsController {
    @Get('/')
    list() {
      return { cats: [] }
    }

    @Roles(Role.Admin)
    @Post('/')
    create() {
      return { created: true }
    }
  }

  void [AuthGuard, RolesGuard, CatsController]

  async function ready() {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .guards(g => g.global(AuthGuard, RolesGuard))
      .build()
    await app.ready()
    return app
  }

  it('rejects a missing token with 401', async () => {
    const app = await ready()

    const res = await app.fetch('/cats', { method: 'POST' })
    expect(res.status).toBe(401)

    await app.close()
  })

  it('rejects a user without the required role with 403', async () => {
    const app = await ready()

    const res = await app.fetch('/cats', {
      method: 'POST',
      headers: { authorization: 'Bearer user' },
    })
    expect(res.status).toBe(403)

    await app.close()
  })

  it('allows an admin to create', async () => {
    const app = await ready()

    const res = await app.fetch('/cats', {
      method: 'POST',
      headers: { authorization: 'Bearer admin' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: true })

    await app.close()
  })

  it('allows any authenticated caller on a route with no @Roles', async () => {
    const app = await ready()

    const res = await app.fetch('/cats', {
      headers: { authorization: 'Bearer user' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cats: [] })

    await app.close()
  })
})

describe('scope', () => {
  let requestScoped = 0
  let singleton = 0

  @Injectable()
  @Lifetime(Scopes.REQUEST)
  class RequestGuard implements Guard {
    constructor() {
      requestScoped++
    }

    guard(): boolean {
      return true
    }
  }

  @Injectable()
  class SingletonGuard implements Guard {
    constructor() {
      singleton++
    }

    guard(): boolean {
      return true
    }
  }

  @Controller('/scope-req')
  class RequestScopeController {
    @UseGuards(RequestGuard)
    @Get('/')
    ok() {
      return { ok: true }
    }
  }

  @Controller('/scope-single')
  class SingletonScopeController {
    @UseGuards(SingletonGuard)
    @Get('/')
    ok() {
      return { ok: true }
    }
  }

  void [RequestGuard, SingletonGuard, RequestScopeController, SingletonScopeController]

  it('resolves a request-scoped guard per request', async () => {
    requestScoped = 0
    const app = buildApp()
    await app.ready()

    await app.fetch('/scope-req')
    await app.fetch('/scope-req')
    expect(requestScoped).toBe(2)

    await app.close()
  })

  it('does not reconstruct a singleton guard per request', async () => {
    singleton = 0
    const app = buildApp()
    await app.ready()

    const constructedAtReady = singleton
    expect(constructedAtReady).toBeGreaterThanOrEqual(1)

    await app.fetch('/scope-single')
    await app.fetch('/scope-single')
    expect(singleton).toBe(constructedAtReady)

    await app.close()
  })
})

describe('zero_cost', () => {
  @Injectable()
  class HookGuard implements Guard {
    guard(): boolean {
      return true
    }
  }

  @Controller('/guard-hooks')
  class GuardHookController {
    @Get('/plain')
    plain() {
      return { ok: true }
    }

    @UseGuards(HookGuard)
    @Get('/guarded')
    guarded() {
      return { ok: true }
    }
  }

  void [HookGuard, GuardHookController]

  const registered = new Map<string, RouteOptions>()
  let app: WebApplication

  beforeAll(async () => {
    const server = fastify({ logger: false })
    server.addHook('onRoute', route => {
      registered.set(`${route.method} ${route.url}`, route as RouteOptions)
    })

    app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('leaves onRequest empty on a route with no guards', () => {
    const route = registered.get('GET /guard-hooks/plain')!

    expect(route).toBeDefined()
    expect(route.onRequest).toBeUndefined()
  })

  it('attaches a function, not a one-element array, when a route has guards', () => {
    const route = registered.get('GET /guard-hooks/guarded')!

    expect(typeof route.onRequest).toBe('function')
  })
})

describe('structural_guard', () => {
  // `Guard` is an interface: a class is a guard because it has a `guard()` method, not because it
  // extends a base. A class that never names `Guard` still compiles and runs.
  @Injectable()
  class BareGuard {
    guard(): boolean {
      return false
    }
  }

  @Controller('/bare-guard')
  class BareGuardController {
    @UseGuards(BareGuard)
    @Get('/')
    ok() {
      return { ok: true }
    }
  }

  void [BareGuard, BareGuardController]

  it('runs a guard class that does not declare "implements Guard"', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.fetch('/bare-guard')
    expect(res.status).toBe(403)

    await app.close()
  })
})

describe('use_guards_unbound', () => {
  it('rejects when the referenced guard has no binding', async () => {
    class UnboundGuard implements Guard {
      guard(): boolean {
        return true
      }
    }

    @UseGuards(UnboundGuard)
    @Controller('/unbound-guard')
    class UnboundGuardController {
      @Get('/')
      ok() {
        return { ok: true }
      }
    }
    void [UnboundGuardController]

    const app = buildApp()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
