import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'
import fastify from 'fastify'
import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authorize,
  BaseAuthenticationHandler,
  Controller,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
  registerPlugin,
  type Context,
  type HTTPPlugin,
} from '../index.js'

/**
 * Where the authentication gate sits among the plugins, which is wherever `.authentication(...)` was written.
 *
 * There is no band putting it behind everything any more, and that is the point: the two constraints pull
 * opposite ways and only the application knows which it wants. CORS must precede the gate, because a rejected
 * cross-origin request still needs the headers on its way out. A hook that reads `req.user`, or one that
 * should not run for a caller who will be refused, must follow it. Writing the calls in order is how an
 * application says which is which.
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

/** Stands in for `@caffeinejs/cors`: stamps a header from an `onRequest` hook, and records that it ran. */
function stamping(name: string, ran: string[]): Feature {
  return {
    name,
    install(ctx) {
      ctx.addFeature({
        [kFeatureName]: name,
        [kBootstrap](kit: BootstrapKit): void {
          const plugin: HTTPPlugin = async instance => {
            instance.addHook('onRequest', (_request, reply, done) => {
              ran.push(name)
              reply.header(`x-${name}`, 'yes')
              done()
            })
          }

          registerPlugin(kit, fp(plugin, { name }))
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

function guardedApp(ran: string[]) {
  return createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
    .extend(stamping('before', ran))
    .authentication(auth => auth.addStrategy('Never', new NeverAuthenticates()).default('Never'))
    .extend(stamping('after', ran))
    .build()
}

describe('the authentication gate registers where it was written', () => {
  it('runs a plugin extended before it, and carries its headers out on the 401', async () => {
    const ran: string[] = []
    const app = guardedApp(ran)

    try {
      await app.ready()
      const res = await app.fetch('/gate-order')

      expect(res.status).toBe(401)
      // The CORS case: the hook ran before the gate short-circuited, so its header is on the rejection.
      expect(res.headers.get('x-before')).toBe('yes')
      expect(ran).toContain('before')
    } finally {
      await app.close()
    }
  })

  it('does not run a plugin extended after it for a request the gate rejected', async () => {
    const ran: string[] = []
    const app = guardedApp(ran)

    try {
      await app.ready()
      const res = await app.fetch('/gate-order')

      expect(res.status).toBe(401)
      expect(res.headers.get('x-after')).toBeNull()
      expect(ran).not.toContain('after')
    } finally {
      await app.close()
    }
  })

  // The assertion the gate used to carry. It is checked whether or not `.authentication(...)` was ever
  // called — which is the case it exists for, and the reason it does not live in the gate any more.
  it('refuses to start when a route is protected and nothing configured authentication', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()

    await expect(app.ready()).rejects.toMatchObject({ code: 'ERR_AUTHENTICATION_REQUIRED' })
  })
})
