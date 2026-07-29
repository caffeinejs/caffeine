import { describe, it, expect, beforeAll } from 'vitest'
import fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
import {
  Authorize,
  type Context,
  Controller,
  Get,
  Params,
  context,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import { oauthServerUp, pickCookie, springLogin } from './internal/spring/index.js'

const OAUTH = 'http://localhost:9000'
const CALLBACK_ORIGIN = 'http://localhost:9999'
const SESSION_SECRET = 'spring-oidc-e2e-session-secret-32c!!'

@Authorize()
@Controller('/oidc-me')
class OidcMeController {
  @Get('/')
  @Params([context()])
  me(ctx: Context) {
    return {
      sub: ctx.user.findFirst('sub')?.value,
      email: ctx.user.findFirst('email')?.value,
    }
  }
}

@Authorize({ roles: ['admin'] })
@Controller('/oidc-admin')
class OidcAdminController {
  @Get('/')
  admin() {
    return { ok: true }
  }
}

@Authorize({ roles: ['superadmin'] })
@Controller('/oidc-superadmin')
class OidcSuperadminController {
  @Get('/')
  superadmin() {
    return { ok: true }
  }
}

void [OidcMeController, OidcAdminController, OidcSuperadminController]

function buildApp() {
  const f = fastify()
  f.register(FastifyCookie)
  const builder = createWebApplication(fastifyAdapterFactory(f))
  builder.authentication.addOIDC('spring', o => o
    .clientID('caffeine-oidc')
    .clientSecret('caffeine-oidc-secret')
    .sessionSecret(SESSION_SECRET)
    .callbackURL(`${CALLBACK_ORIGIN}/oidc/callback`)
    .authorizationEndpoint(`${OAUTH}/oauth2/authorize`)
    .tokenEndpoint(`${OAUTH}/oauth2/token`)
    .jwksURI(`${OAUTH}/oauth2/jwks`)
    .issuer(OAUTH)
    .scopes('openid', 'profile', 'email'))
  void builder.authorization
  return builder.build()
}

const serverUp = await oauthServerUp()

describe.skipIf(!serverUp)('OIDC e2e against Spring Authorization Server', () => {
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
  })

  it('completes the authorization-code flow and authorizes by session', async () => {
    // 1. Protected route with no session → 302 challenge to the provider; capture the state cookie.
    const challenge = await app.fetch('/oidc-me')
    expect(challenge.status).toBe(302)
    const authorizeUrl = challenge.headers.get('location')!
    expect(authorizeUrl).toContain(`${OAUTH}/oauth2/authorize`)
    const stateCookie = pickCookie(challenge, 'state')

    // 2. Drive Spring's login → redirect to the caffeine callback carrying the code.
    const callbackUrl = new URL(await springLogin(authorizeUrl, 'alice', 'wonderland', CALLBACK_ORIGIN))
    expect(callbackUrl.searchParams.get('code')).toBeTruthy()

    // 3. caffeine callback: exchange code at /oauth2/token, verify id_token via /oauth2/jwks,
    //    set the session cookie, redirect to the original route.
    const callback = await app.fetch(`${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: { cookie: stateCookie },
    })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/oidc-me')
    const sessionCookie = pickCookie(callback, 'session')

    // 4. Authenticated request → 200 with identity claims from the id_token.
    const me = await app.fetch('/oidc-me', { headers: { cookie: sessionCookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ sub: 'alice', email: 'alice@example.com' })

    // 5. authz positive: the session holds the admin role → 200.
    const admin = await app.fetch('/oidc-admin', { headers: { cookie: sessionCookie } })
    expect(admin.status).toBe(200)

    // 6. authz negative: the session lacks the superadmin role → 403.
    const superadmin = await app.fetch('/oidc-superadmin', { headers: { cookie: sessionCookie } })
    expect(superadmin.status).toBe(403)
  })
})
