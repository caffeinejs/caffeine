import { describe, it, expect, beforeAll } from 'vitest'
import fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
import {
  Authorize,
  type Context,
  Controller,
  Get,
  Params,
  $p,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import { oauthServerUp, pickCookie, springLogin } from './internal/spring/index.js'

const OAUTH = 'http://localhost:9000'
const CALLBACK_ORIGIN = 'http://localhost:9999'
const SESSION_SECRET = 'spring-oauth2-e2e-session-secret-32!'

@Authorize()
@Controller('/oauth2-me')
class OAuth2MeController {
  @Get('/')
  @Params([$p.context()])
  me(ctx: Context) {
    return {
      sub: ctx.user.findFirst('sub')?.value,
      email: ctx.user.findFirst('email')?.value,
    }
  }
}

@Authorize({ roles: ['admin'] })
@Controller('/oauth2-admin')
class OAuth2AdminController {
  @Get('/')
  admin() {
    return { ok: true }
  }
}

@Authorize({ roles: ['superadmin'] })
@Controller('/oauth2-superadmin')
class OAuth2SuperadminController {
  @Get('/')
  superadmin() {
    return { ok: true }
  }
}

void [OAuth2MeController, OAuth2AdminController, OAuth2SuperadminController]

function buildApp() {
  const f = fastify()
  f.register(FastifyCookie)
  const builder = createWebApplication(fastifyAdapterFactory(f))
  builder.authentication(auth => auth.addOAuth2('spring-oauth2', o => o
    .clientID('caffeine-oauth2')
    .clientSecret('caffeine-oauth2-secret')
    .sessionSecret(SESSION_SECRET)
    .callbackURL(`${CALLBACK_ORIGIN}/oauth2/callback`)
    .authorizationEndpoint(`${OAUTH}/oauth2/authorize`)
    .tokenEndpoint(`${OAUTH}/oauth2/token`)
    .userInfoEndpoint(`${OAUTH}/userinfo`)
    .subjectClaim('sub')
    .scopes('openid', 'profile', 'email')))
  return builder.build()
}

const serverUp = await oauthServerUp()

describe.skipIf(!serverUp)('OAuth2 e2e against Spring Authorization Server', () => {
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
  })

  it('completes the authorization-code flow and resolves identity via userinfo', async () => {
    // 1. Protected route with no session → 302 challenge; capture the state cookie.
    const challenge = await app.fetch('/oauth2-me')
    expect(challenge.status).toBe(302)
    const authorizeUrl = challenge.headers.get('location')!
    expect(authorizeUrl).toContain(`${OAUTH}/oauth2/authorize`)
    const stateCookie = pickCookie(challenge, 'state')

    // 2. Drive Spring's login → callback with the code.
    const callbackUrl = new URL(await springLogin(authorizeUrl, 'alice', 'wonderland', CALLBACK_ORIGIN))
    expect(callbackUrl.searchParams.get('code')).toBeTruthy()

    // 3. caffeine callback: exchange code at /oauth2/token, fetch /userinfo with the access token,
    //    set the session cookie, redirect to the original route.
    const callback = await app.fetch(`${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: { cookie: stateCookie },
    })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/oauth2-me')
    const sessionCookie = pickCookie(callback, 'session')

    // 4. Authenticated request → 200 with identity from userinfo.
    const me = await app.fetch('/oauth2-me', { headers: { cookie: sessionCookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ sub: 'alice', email: 'alice@example.com' })

    // 5. authz positive: the session holds the admin role → 200.
    const admin = await app.fetch('/oauth2-admin', { headers: { cookie: sessionCookie } })
    expect(admin.status).toBe(200)

    // 6. authz negative: the session lacks the superadmin role → 403.
    const superadmin = await app.fetch('/oauth2-superadmin', { headers: { cookie: sessionCookie } })
    expect(superadmin.status).toBe(403)
  })
})
