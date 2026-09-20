import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { EnvConfigSource, InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import {
  AllowAnonymous,
  AuthenticationSchemeProvider,
  Authorize,
  Controller,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../../index.js'
import { SCHEME_SCHEMAS, authConfigSchema, credentialsConfigSchema, refreshConfigSchema } from '../config.js'
import type { AuthSchemeDescriptor } from '../descriptor.js'
import { kAuthSchemeDescriptors } from '../keys.js'

// The application owns the schema: it declares where the authentication block lives — importing the feature's
// own schema for the scheme-independent half — and `a.config(c.auth)` hands the feature that node.
//
// `schemes` is declared **precisely**, splicing in each kind's own schema, so each scheme's options are validated.
const rootSchema = $t.Object({
  auth: $t.Object(
    {
      ...authConfigSchema.properties,
      schemes: $t.Optional(
        $t.Object(
          {
            jwt: $t.Optional(SCHEME_SCHEMAS.jwt),
            Bearer: $t.Optional(SCHEME_SCHEMAS.jwt),
            Basic: $t.Optional(SCHEME_SCHEMAS.basic),
            Cookie: $t.Optional(SCHEME_SCHEMAS.cookie),
          },
          { default: {} },
        ),
      ),
    },
    { default: {} },
  ),
})
const kRootConfig = token<InferConfig<typeof rootSchema>>(Symbol('app.config'))

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
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(env({ AUTH__SCHEMES__JWT__SECRET: ENV_SECRET }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a.config(c.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
    )

    await app.ready()

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
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).authentication(a =>
      a.addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
    )

    await app.ready()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(CODE_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  // Building last is what puts each scheme's own validation on the merged options.
  it('validates the merged options, not the code half', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new InlineConfigSource({ auth: { schemes: { Cookie: { sessionSecret: 'too-short' } } } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a.config(c.auth).addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!')),
    )

    await expect(app.ready()).rejects.toThrow(/sessionSecret must be at least 32 characters/)
  })

  it('configures a basic realm and a cookie name from the tree', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
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
      .build()
    // A cookie scheme is registered, so the cookie plugin has to be there first or the application refuses to start.
    const server = fastify({ logger: false })

    const app = createWebApplication(fastifyAdapterFactory(server), {
      config: conf,
    }).authentication((a, c) =>
      a
        .config(c.auth)
        .addBasic(b => b.realm('From Code').validate(() => null))
        .addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!'))
        .default('Basic'),
    )

    await app.ready()

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
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(env({ AUTH__DEFAULT_AUTHENTICATE_SCHEME: 'Bearer' }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a
        .config(c.auth)
        .addBasic(b => b.validate(() => null))
        .addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
    )

    await app.ready()

    expect(app.container.get(AuthenticationSchemeProvider).defaultAuthenticateScheme).toBe('Bearer')

    await app.close()
  })

  // A code-only member has to survive the round trip: it is never written to the tree.
  it('keeps a code-only callback on a configured scheme', async () => {
    let validated = 0

    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new InlineConfigSource({ auth: { schemes: { Basic: { realm: 'Configured' } } } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a.config(c.auth).addBasic(b =>
        b.realm('Coded').validate(() => {
          validated++
          return null
        }),
      ),
    )

    await app.ready()

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
          schemes: $t.Optional($t.Object({ Bearer: $t.Optional(SCHEME_SCHEMAS.jwt) })),
        }),
      }),
    })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { auth: { schemes: { Bearer: { secret: ENV_SECRET } } } } }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a.config(c.app.auth).addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
    )

    await app.ready()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  // The schema the package exports for the block leaves each scheme's keys open, so nothing upstream converts what
  // an environment variable carries. The scheme's own schema does, when the values are applied.
  describe('under the exported schema, which leaves the scheme keys open', () => {
    const openSchema = $t.Object({ auth: $t.Object({ ...authConfigSchema.properties }, { default: {} }) })
    const kOpenConfig = token<InferConfig<typeof openSchema>>(Symbol('app.config.open'))

    function appFrom(values: Record<string, string>) {
      const conf = newConfiguration(openSchema, kOpenConfig).source(env(values)).build()

      return createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { config: conf }).authentication(
        (a, c) => a.config(c.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).issuer('local').audience('local')),
      )
    }

    // "false" is a non-empty string, and a non-empty string is true.
    it('turns a boolean option off when the variable says false', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'false' })
      await app.ready()

      const res = await app.fetch('/protected', { headers: { authorization: 'Bearer not-a-token' } })

      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    })

    it('leaves it on when the variable says true', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'true' })
      await app.ready()

      const res = await app.fetch('/protected', { headers: { authorization: 'Bearer not-a-token' } })

      expect(res.headers.get('www-authenticate')).toMatch(/error_description=/)
    })

    // A misspelt key used to be dropped, so the audience check the operator believed was on never ran.
    it('refuses to start on a key the scheme does not have, and names the ones it has', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__AUDIANCE: 'someone-else' })

      await expect(app.ready()).rejects.toMatchObject({
        code: 'ERR_AUTH_CONFIGURATION',
        message: expect.stringMatching(/authentication scheme "jwt".*"audiance" is not an option.*"audience"/),
      })
    })

    it('refuses to start on a value the option does not take', async () => {
      const app = appFrom({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'maybe' })

      await expect(app.ready()).rejects.toMatchObject({
        code: 'ERR_AUTH_CONFIGURATION',
        message: expect.stringContaining('includeErrorDetails'),
      })
    })

    // A client id and a callback URL are what a deployment most often sets from its environment, and `CLIENT_ID`
    // folds to `clientId`. An option spelled any other way is one the variable never reaches.
    it('reaches an OAuth 2.0 scheme through the variables a deployment would write', async () => {
      const conf = newConfiguration(openSchema, kOpenConfig)
        .source(
          env({
            AUTH__SCHEMES__OAUTH__CLIENT_ID: 'env-client',
            AUTH__SCHEMES__OAUTH__CALLBACK_URL: 'https://app.test/signin/callback',
            AUTH__SCHEMES__OAUTH__USE_PKCE: 'false',
          }),
        )
        .build()
      const server = fastify({ logger: false })

      const app = createWebApplication(fastifyAdapterFactory(server), { config: conf }).authentication((a, c) =>
        a
          .config(c.auth)
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
      )

      await app.ready()

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

  // The guard behind the test above, for every option there is: the key a block declares has to be the key its
  // own variable folds to. `clientID` is not — `CLIENT_ID` folds to `clientId` — so such a key would be one that
  // only `CLIENT_I_D` reaches.
  describe('every configurable key', () => {
    const variableFor = (key: string): string =>
      key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toUpperCase()

    const foldedFrom = (variable: string): string[] => {
      const [layer] = new EnvConfigSource({ env: { [`BLOCK__${variable}`]: 'x' } }).load({
        logger: { warn: () => undefined },
      } as never)

      return Object.keys((layer.data as { block: Record<string, unknown> }).block)
    }

    const blocks: Array<[string, { properties: Record<string, unknown> }]> = [
      ['auth', authConfigSchema],
      ['credentials', credentialsConfigSchema],
      ['refresh', refreshConfigSchema],
      ...Object.entries(SCHEME_SCHEMAS),
    ]

    it.each(blocks)('of the %s block is the key its environment variable folds to', (_name, schema) => {
      for (const key of Object.keys(schema.properties)) {
        expect(foldedFrom(variableFor(key))).toEqual([key])
      }
    })
  })
})
