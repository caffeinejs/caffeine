import { token } from '@caffeinejs/di'
import { $t, type InferSchema } from '@caffeinejs/std'
import {
  ConfigPriority,
  EnvConfigProvider,
  InlineConfigProvider,
  Configuration,
  type ConfigHandle,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import {
  AllowAnonymous,
  Authorize,
  Controller,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../../index.js'
import { authConfigSchema } from '../config.js'
import type { AuthSchemeDescriptor } from '../descriptor.js'
import { kAuthContribution, kAuthSchemeDescriptors } from '../keys.js'

// The application owns the schema: it declares where the authentication block lives — importing the feature's
// own schema for the scheme-independent half — and `a.config(c => c.auth)` points the feature at it. `schemes`
// stays an open record here: each scheme's shape is governed by its own slice, nested under this block.
const rootSchema = $t.Object({
  auth: $t.Object(
    {
      ...authConfigSchema.properties,
      schemes: $t.Optional($t.Record($t.String(), $t.Record($t.String(), $t.Unknown()))),
    },
    { default: {} },
  ),
})
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const CODE_SECRET = 'code-secret-key-must-be-at-least-32-chars!'
const ENV_SECRET = 'env-secret-key-must-be-at-least-32-chars!!'

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

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
  // The scheme is named `jwt` rather than left as the default `Bearer` because `EnvConfigProvider` lowercases
  // each path segment — `AUTH__SCHEMES__BEARER__SECRET` addresses `auth.schemes.bearer`, which is not where a
  // scheme called `Bearer` lives. See `schemeNamespace`.
  it('takes a JWT secret from the environment, over the one set in code', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ AUTH__SCHEMES__JWT__SECRET: ENV_SECRET }), ConfigPriority.ENV),
      )
      .authentication(a =>
        a.config(c => c.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
      )
      .build()
      .useAuthenticationAndAuthorization()

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
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .authentication(a => a.addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()))
      .build()
      .useAuthenticationAndAuthorization()

    await app.ready()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(CODE_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  it('redacts a configured secret in the diagnostics while the handler still authenticates with it', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ AUTH__SCHEMES__JWT__SECRET: ENV_SECRET }), ConfigPriority.ENV),
      )
      .authentication(a =>
        a.config(c => c.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
      )
      .build()
      .useAuthenticationAndAuthorization()

    await app.ready()

    const diagnostics = app.container.get(Configuration).diagnostics
    expect(diagnostics.valueAt('auth.schemes.jwt.secret')).toBe('[redacted]')
    expect(JSON.stringify(diagnostics.snapshot)).not.toContain(ENV_SECRET)

    // Redacted at the diagnostic boundary only — the scheme itself has the real value.
    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })

  // Building last is what puts each scheme's own validation on the merged options.
  it('validates the merged options, not the code half', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            auth: { schemes: { Cookie: { sessionSecret: 'too-short' } } },
          }),
        ),
      )
      .authentication(a =>
        a.config(c => c.auth).addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!')),
      )
      .build()

    await expect(app.ready()).rejects.toThrow(/sessionSecret must be at least 32 characters/)
  })

  it('configures a basic realm and a cookie name from the tree', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            auth: {
              schemes: {
                Basic: { realm: 'From Config' },
                Cookie: { cookieName: 'configured.session' },
              },
            },
          }),
        ),
      )
      .authentication(a =>
        a
          .config(c => c.auth)
          .addBasic(b => b.realm('From Code').validate(() => null))
          .addCookie(b => b.sessionSecret('a-perfectly-long-session-secret-value!!'))
          .default('Basic'),
      )
      .build()
      .useAuthenticationAndAuthorization()

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
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ AUTH__DEFAULT_AUTHENTICATE_SCHEME: 'Bearer' }), ConfigPriority.ENV),
      )
      .authentication(a =>
        a
          .config(c => c.auth)
          .addBasic(b => b.validate(() => null))
          .addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
      )
      .build()
      .useAuthenticationAndAuthorization()

    await app.ready()

    expect(app.contributions.get(kAuthContribution).defaultAuthenticateScheme).toBe('Bearer')

    await app.close()
  })

  // A code-only member has to survive the round trip: it is never written to the tree.
  it('keeps a code-only callback on a configured scheme', async () => {
    let validated = 0

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            auth: { schemes: { Basic: { realm: 'Configured' } } },
          }),
        ),
      )
      .authentication(a =>
        a
          .config(c => c.auth)
          .addBasic(b =>
            b.realm('Coded').validate(() => {
              validated++
              return null
            }),
          ),
      )
      .build()
      .useAuthenticationAndAuthorization()

    await app.ready()

    await app.fetch('/protected', {
      headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
    })
    expect(validated).toBe(1)

    await app.close()
  })

  it('re-points every auth namespace together through .config()', async () => {
    const schema = $t.Object({
      app: $t.Object({
        auth: $t.Object({
          defaultAuthenticateScheme: $t.Optional($t.String()),
        }),
      }),
    })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .config(schema, kConfig, c =>
        c.source(
          new InlineConfigProvider({
            app: { auth: { schemes: { Bearer: { secret: ENV_SECRET } } } },
          }),
        ),
      )
      .authentication(a =>
        a.config(c => c.app.auth).addJWTBearer(b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
      )
      .build()
      .useAuthenticationAndAuthorization()

    await app.ready()

    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
    })
    expect(res.status).toBe(200)

    await app.close()
  })
})
