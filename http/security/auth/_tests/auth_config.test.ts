import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { ConfigStore, EnvConfigSource, InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
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
import { SCHEME_SCHEMAS, authConfigSchema } from '../config.js'
import type { AuthSchemeDescriptor } from '../descriptor.js'
import { kAuthSchemeDescriptors } from '../keys.js'

// The application owns the schema: it declares where the authentication block lives — importing the feature's
// own schema for the scheme-independent half — and `a.config(c.auth)` hands the feature that node.
//
// `schemes` is declared **precisely**, splicing in each kind's own schema. That is what carries `$t.Secret`
// into the tree, and `$t.Secret` is what the diagnostics redact on: an open record would validate the same
// values and print the secrets.
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

  it('redacts a configured secret in the diagnostics while the handler still authenticates with it', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(env({ AUTH__SCHEMES__JWT__SECRET: ENV_SECRET }))
      .build()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      config: conf,
    }).authentication((a, c) =>
      a.config(c.auth).addJWTBearer('jwt', b => b.secret(CODE_SECRET).allowAnyIssuer().allowAnyAudience()),
    )

    await app.ready()

    const store = app.container.get(ConfigStore)
    expect(store.explain('auth.schemes.jwt.secret').value).toBe('[redacted]')
    expect(JSON.stringify(store.explain('auth.schemes.jwt.secret'))).not.toContain(ENV_SECRET)
    expect(JSON.stringify(store.inspect())).not.toContain(ENV_SECRET)

    // Redacted at the diagnostic boundary only — the scheme itself has the real value.
    const res = await app.fetch('/protected', {
      headers: { authorization: `Bearer ${await tokenSignedWith(ENV_SECRET)}` },
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
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
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
})
