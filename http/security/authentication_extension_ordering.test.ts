import { token } from '@caffeinejs/di'
import {
  kBootstrap,
  kExtensionStage,
  kFeatureName,
  type BootstrapKit,
  type ExtensionStage,
  type Feature,
} from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authorize,
  BaseAuthenticationHandler,
  type Context,
  Controller,
  Get,
  ServerExtension,
  type ServerExtensionContext,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

/**
 * The `gate` stage exists so the authentication hook registers behind every `default` extension — CORS in
 * particular. A rejected cross-origin request still has to carry the headers a `default` extension set, so
 * that extension's `onRequest` hook has to have run before the 401 short-circuits the lifecycle.
 *
 * Its own file: the `@Authorize` controller registers into the process-global registry, and a guarded
 * controller trips every "this application starts" assertion built afterwards in the same module.
 */

class NeverAuthenticates extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(_ctx: Context): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

/** A `default`-stage extension, standing in for `@caffeinejs/cors`: adds an `onRequest` hook that sets a header. */
class HeaderStamp extends ServerExtension {
  readonly name = 'header-stamp'
  readonly [kExtensionStage]: ExtensionStage = 'default'

  configure(ctx: ServerExtensionContext): void {
    ctx.server.addHook('onRequest', (_request, reply, done) => {
      reply.header('x-stamped', 'yes')
      done()
    })
  }
}

function featureFor(extension: ServerExtension): Feature {
  const key = token<ServerExtension>(Symbol(`ext.${extension.name}`))

  return {
    name: extension.name,
    install(ctx) {
      ctx.addFeature({
        [kFeatureName]: extension.name,
        [kBootstrap](kit: BootstrapKit): void {
          kit.container.bind(key, t => t.toValue(extension))
          kit.extensions.register(key)
        },
      })
    },
  }
}

@Authorize()
@Controller('/gate-order')
class GuardedController {
  @Get('/')
  list() {
    return { ok: true }
  }
}
void [GuardedController]

describe('authentication extension — hook ordering', () => {
  it('registers its onRequest hook behind a default-stage extension, so a 401 still carries that extension header', async () => {
    const builder = createWebApplication(fastifyAdapterFactory(fastify())).extend(featureFor(new HeaderStamp()))
    builder.authentication(auth => auth.addStrategy('Header', new NeverAuthenticates()).default('Header'))

    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/gate-order')

    expect(res.status).toBe(401)
    expect(res.headers.get('x-stamped')).toBe('yes')

    await app.close()
  })
})
