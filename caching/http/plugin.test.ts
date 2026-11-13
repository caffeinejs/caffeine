import { Injectable } from '@caffeinejs/di'
import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorize,
  BaseAuthenticationHandler,
  Controller,
  Get,
  Identity,
  Principal,
  UseGuards,
  type Guard,
  type GuardInput,
  type IContext,
} from '@caffeinejs/http'
import { authentication, createWebApplication } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../store/memory/index.js'
import { CacheControl, HTTPCaching } from './index.js'

// Signs in a request carrying a `session` cookie and no other.
class SessionCookieHandler extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    if (ctx.req.header('cookie')?.includes('session=') !== true) {
      return AuthenticateResult.none()
    }
    const principal = new Principal(true, [new Identity('session', true, [])])
    return AuthenticateResult.success(new AuthenticationTicket(principal, 'session'))
  }
}

@Injectable()
class PassHeaderGuard implements Guard {
  guard(input: GuardInput): boolean {
    return input.context.req.header('x-pass') === 'yes'
  }
}

let guardedCalls = 0
let signedInCalls = 0

@Controller('/cache-guarded')
class GuardedController {
  @CacheControl({ ttl: 60 * Second })
  @UseGuards(PassHeaderGuard)
  @Get('/report')
  report() {
    return { n: ++guardedCalls }
  }
}

@Controller('/cache-signed-in')
class SignedInController {
  @CacheControl({ ttl: 60 * Second, privacy: 'public' })
  @Authorize()
  @Get('/catalog')
  catalog() {
    return { n: ++signedInCalls }
  }
}
void [GuardedController, SignedInController]

/**
 * A stored response is served only to a request that passed every check the route makes: a cache hit that ran
 * ahead of a guard or of authentication hands a response to a caller the route refuses.
 */
describe('the cache on a protected route', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start() {
    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('session', new SessionCookieHandler()).default('session')))
      .with(authentication())
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  it('serves a stored response only to a request its guard lets through', async () => {
    guardedCalls = 0
    const app = await start()

    const passed = await app.request('/cache-guarded/report', { headers: { 'x-pass': 'yes' } })
    expect(passed.status).toBe(200)
    expect(passed.headers.get('x-cache')).toBe('MISS')

    const refused = await app.request('/cache-guarded/report')
    expect(refused.status).toBe(403)
    expect(guardedCalls).toBe(1)

    // The entry the refusal was kept from is there: the guard, not an empty store, answered.
    const again = await app.request('/cache-guarded/report', { headers: { 'x-pass': 'yes' } })
    expect(again.headers.get('x-cache')).toBe('HIT')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ n: 1 })
  })

  it('serves a stored response only to a request that authenticates', async () => {
    signedInCalls = 0
    const app = await start()

    const alice = await app.request('/cache-signed-in/catalog', { headers: { cookie: 'session=alice' } })
    expect(alice.status).toBe(200)
    expect(alice.headers.get('x-cache')).toBe('MISS')

    const anonymous = await app.request('/cache-signed-in/catalog')
    expect(anonymous.status).toBe(401)
    expect(signedInCalls).toBe(1)

    // The route shares its entry between callers (`privacy: 'public'`), so another signed-in caller is served the
    // entry the anonymous request was kept from.
    const bob = await app.request('/cache-signed-in/catalog', { headers: { cookie: 'session=bob' } })
    expect(bob.headers.get('x-cache')).toBe('HIT')
    expect(bob.status).toBe(200)
    expect(await bob.json()).toEqual({ n: 1 })
  })
})
