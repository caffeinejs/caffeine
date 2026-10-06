import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import type { Context } from '../../../context.js'
import {
  AllowAnonymous,
  AuthenticationSchemeProvider,
  AuthenticationTicket,
  Authorize,
  Claim,
  Controller,
  CookieAuthenticationHandler,
  CookieAuthenticationOptionsBuilder,
  Get,
  Identity,
  Principal,
  createWebApplication,
  Authentication,
  authentication,
} from '../../../index.js'
import type { AuthSchemeDescriptor } from '../descriptor.js'
import { kAuthSchemeDescriptors } from '../keys.js'

// The application owns the schema: it declares where the authentication block lives, with each scheme it
// configures typed, and `a.config(c.auth)` hands the feature that node.
const jwtBlock = $t.Object({ secret: $t.Optional($t.String()), includeErrorDetails: $t.Optional($t.Boolean()) })

const rootSchema = $t.Object({
  auth: $t.Object(
    {
      defaultAuthenticateScheme: $t.Optional($t.String()),
      schemes: $t.Optional(
        $t.Object(
          {
            jwt: $t.Optional(jwtBlock),
            Bearer: $t.Optional(jwtBlock),
            Basic: $t.Optional($t.Object({ realm: $t.Optional($t.String()) })),
            Cookie: $t.Optional(
              $t.Object({ sessionSecret: $t.Optional($t.String()), cookieName: $t.Optional($t.String()) }),
            ),
          },
          { default: {} },
        ),
      ),
    },
    { default: {} },
  ),
})

const CODE_SECRET = 'code-secret-key-must-be-at-least-32-chars!'
const ENV_SECRET = 'env-secret-key-must-be-at-least-32-chars!!'

const env = (values: Record<string, string>) => new EnvConfigSource({ env: values })

@Authorize()
@Controller('/protected')
class ProtectedController {
  @Get('/')
  list(): unknown {
    return { ok: true }
  }
}

@Controller('/open')
class OpenController {
  @Get('/')
  @AllowAnonymous()
  list(): unknown {
    return { ok: true }
  }
}
void [ProtectedController, OpenController]

function tokenSignedWith(secret: string): Promise<string> {
  return new SignJWT({ sub: 'user-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

describe('authentication configuration', () => {
  // The case the whole reordering was for: a secret that never appears in code or in a file.
  //
  // The scheme is named `jwt` rather than left as the default `Bearer` because `EnvConfigSource` lowercases
  // each path segment — `AUTH__SCHEMES__BEARER__SECRET` addresses `auth.schemes.bearer`, which is not where a
  it('takes a JWT secret from the environment, over the one set in code', async () => {
    const conf = newConfiguration(rootSchema)
      .source(env({ AUTH__SCHEMES__JWT__SECRET: ENV_SECRET }))
      .build().config
    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a.config(config.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
        ),
      )
      .with(authentication())

    await app.bootstrap()

    const withEnvSecret = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
    })
    expect(withEnvSecret.status).toBe(200)

    // The code-set secret is a default, and configuration replaced it outright.
    const withCodeSecret = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(CODE_SECRET)}` },
    })
    expect(withCodeSecret.status).toBe(401)

    await app.close()
  })

  it('leaves the code-set secret in place when configuration carries none', async () => {
    const app = createWebApplication()
      .install(Authentication(a => a.addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience())))
      .with(authentication())

    await app.bootstrap()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(CODE_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  // Building last is what puts each scheme's own validation on the merged options.
  it('validates the merged options, not the code half', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new InlineConfigSource({ auth: { schemes: { Cookie: { sessionSecret: 'too-short' } } } }))
      .build().config
    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a.config(config.auth).addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!')),
        ),
      )
      .with(authentication())

    await expect(app.bootstrap()).rejects.toThrow(/sessionSecret must be at least 32 characters/)
  })

  it('configures a basic realm and a cookie name from the tree', async () => {
    const conf = newConfiguration(rootSchema)
      .source(
        new InlineConfigSource({
          auth: {
            schemes: {
              Basic: { realm: 'From Config' },
              Cookie: { cookieName: 'configured.session' },
            },
          },
        }),
      )
      .build().config
    // A cookie scheme is registered, so the server's cookies have to be on, or the application refuses to start.

    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a
            .config(config.auth)
            .addBasic(b => b.realm('From Code').validate(() => null))
            .addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!'))
            .default('Basic'),
        ),
      )
      .with(authentication())

    await app.bootstrap()

    const res = await app.fetch('/protected')
    expect(res.headers.get('www-authenticate')).toContain('realm="From Config"')

    // The descriptor is computed from the merged options too, so the document describes the real cookie.
    const descriptors = app.container.get<Map<string, AuthSchemeDescriptor>>(kAuthSchemeDescriptors)
    expect(descriptors.get('Cookie')).toMatchObject({
      kind: 'apiKey',
      in: 'cookie',
      name: 'configured.session',
    })

    await app.close()
  })

  it('takes the default scheme from the tree', async () => {
    const conf = newConfiguration(rootSchema)
      .source(env({ AUTH__DEFAULT_AUTHENTICATE_SCHEME: 'Bearer' }))
      .build().config
    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a
            .config(config.auth)
            .addBasic(b => b.validate(() => null))
            .addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
        ),
      )
      .with(authentication())

    await app.bootstrap()

    expect(app.container.get(AuthenticationSchemeProvider).defaultAuthenticateScheme).toBe('Bearer')

    await app.close()
  })

  // A code-only member has to survive the round trip: it is never written to the tree.
  it('keeps a code-only callback on a configured scheme', async () => {
    let validated = 0

    const conf = newConfiguration(rootSchema)
      .source(new InlineConfigSource({ auth: { schemes: { Basic: { realm: 'Configured' } } } }))
      .build().config
    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a.config(config.auth).addBasic(b =>
            b.realm('Coded').validate(() => {
              validated++
              return null
            }),
          ),
        ),
      )
      .with(authentication())

    await app.bootstrap()

    await app.fetch('/protected', {
      headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
    })
    expect(validated).toBe(1)

    await app.close()
  })

  it('re-points every auth namespace together through the constructor-supplied config', async () => {
    const schema = $t.Object({
      app: $t.Object({
        auth: $t.Object({
          defaultAuthenticateScheme: $t.Optional($t.String()),
          schemes: $t.Optional($t.Object({ Bearer: $t.Optional(jwtBlock) })),
        }),
      }),
    })

    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ app: { auth: { schemes: { Bearer: { secret: ENV_SECRET } } } } }))
      .build().config
    const app = createWebApplication({
      config: conf,
    })
      .install(
        Authentication((a, { config }) =>
          a.config(config.app.auth).addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
        ),
      )
      .with(authentication())

    await app.bootstrap()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  // Keyed by scheme name with each key typed, so what an environment variable carries is converted when the
  // configuration loads.
  describe('under a schema keyed by scheme name', () => {
    const openSchema = $t.Object({
      auth: $t.Object(
        {
          schemes: $t.Optional(
            $t.Record(
              $t.String(),
              $t.Object({
                includeErrorDetails: $t.Optional($t.Boolean()),
                clientId: $t.Optional($t.String()),
                callbackUrl: $t.Optional($t.String()),
                usePkce: $t.Optional($t.Boolean()),
                sessionSecret: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
                domain: $t.Optional($t.String()),
                priority: $t.Optional($t.UnionEnum(['low', 'medium', 'high'])),
              }),
            ),
          ),
        },
        { default: {} },
      ),
    })

    function appFrom(values: Record<string, string>) {
      const conf = newConfiguration(openSchema).source(env(values)).build().config

      return createWebApplication({ config: conf })
        .install(
          Authentication((a, { config }) =>
            a.config(config.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).issuer('local').audience('local')),
          ),
        )
        .with(authentication())
    }

    // "false" is a non-empty string, and a non-empty string is true.
    it('turns a boolean option off when the variable says false', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'false' })
      await app.bootstrap()

      const res = await app.fetch('/protected', { headers: { authorization: 'Bearer not-a-token' } })

      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    })

    it('leaves it on when the variable says true', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'true' })
      await app.bootstrap()

      const res = await app.fetch('/protected', { headers: { authorization: 'Bearer not-a-token' } })

      expect(res.headers.get('www-authenticate')).toMatch(/error_description=/)
    })

    it('refuses to start on a value the option does not take', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'maybe' })

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CONFIG_VALIDATION',
        message: expect.stringContaining('includeErrorDetails'),
      })
    })

    // Rotation is a deployment's to do: the new secret goes first, the one being retired after it, and a session
    // sealed under the old one is let in and sealed again under the new.
    it("rotates a cookie scheme's secrets and scopes its cookie through the variables a deployment would write", async () => {
      const NEWER = 'a-newer-session-secret-of-32-characters-or-more'
      const OLDER = 'an-older-session-secret-of-32-characters-or-more'

      // What signing in under the old secret alone wrote, before the rotation.
      let sealed = ''
      const issued = {
        cookie: (_name: string, value: string) => void (sealed = value),
        header: () => issued,
        req: { basePath: '' },
      } as unknown as Context
      const ada = new Principal(true, new Identity('cookie', true, [new Claim('sub', 'ada', '')]))
      await new CookieAuthenticationHandler(
        'cookie',
        new CookieAuthenticationOptionsBuilder().sessionSecret(OLDER).build(),
      ).persist(issued, new AuthenticationTicket(ada, 'cookie'))

      const conf = newConfiguration(openSchema)
        .source(
          env({
            AUTH__SCHEMES__COOKIE__SESSION_SECRET__0: NEWER,
            AUTH__SCHEMES__COOKIE__SESSION_SECRET__1: OLDER,
            AUTH__SCHEMES__COOKIE__DOMAIN: 'app.test',
            AUTH__SCHEMES__COOKIE__PRIORITY: 'high',
          }),
        )
        .build().config

      const app = createWebApplication({ config: conf })
        .install(
          Authentication((a, { config }) =>
            a.config(config.auth).addCookie('cookie', b => b.sessionSecret('a-code-session-secret-of-32-characters')),
          ),
        )
        .with(authentication())

      await app.bootstrap()

      const res = await app.fetch('/protected', { headers: { cookie: `caf.session=${sealed}` } })
      expect(res.status).toBe(200)

      const reissued = res.headers.getSetCookie().find(line => line.startsWith('caf.session='))!
      expect(reissued).toContain('Domain=app.test')
      expect(reissued).toContain('Priority=High')

      const cookie = reissued.slice(0, reissued.indexOf(';'))
      expect((await app.fetch('/protected', { headers: { cookie } })).headers.getSetCookie()).toEqual([])

      await app.close()
    })

    // A client id and a callback URL are what a deployment most often sets from its environment, and `CLIENT_ID`
    // folds to `clientId`. An option spelled any other way is one the variable never reaches.
    it('reaches an OAuth 2.0 scheme through the variables a deployment would write', async () => {
      const conf = newConfiguration(openSchema)
        .source(
          env({
            AUTH__SCHEMES__OAUTH__CLIENT_ID: 'env-client',
            AUTH__SCHEMES__OAUTH__CALLBACK_URL: 'https://app.test/signin/callback',
            AUTH__SCHEMES__OAUTH__USE_PKCE: 'false',
          }),
        )
        .build().config

      const app = createWebApplication({ config: conf })
        .install(
          Authentication((a, { config }) =>
            a
              .config(config.auth)
              .addOAuth2('oauth', o =>
                o
                  .clientID('code-client')
                  .clientSecret('code-client-secret')
                  .sessionSecret('a-perfectly-long-session-secret-value!!')
                  .authorizationEndpoint('https://provider.test/authorize')
                  .tokenEndpoint('https://provider.test/token')
                  .userInfoEndpoint('https://provider.test/userinfo')
                  .callbackURL('https://app.test/auth/callback'),
              ),
          ),
        )
        .with(authentication())

      await app.bootstrap()

      // The sign-in route follows the configured callback, and what it sends the provider is the configured client.
      const res = await app.fetch('/signin/callback/login', { redirect: 'manual' })
      expect(res.status).toBe(302)

      const authorization = new URL(res.headers.get('location')!)
      expect(authorization.searchParams.get('client_id')).toBe('env-client')
      expect(authorization.searchParams.get('redirect_uri')).toBe('https://app.test/signin/callback')
      expect(authorization.searchParams.has('code_challenge')).toBe(false)

      await app.close()
    })
  })
})
