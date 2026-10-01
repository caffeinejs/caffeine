import { Injectable } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ActionResult,
  BindTo,
  Catch,
  type Context,
  Controller,
  Get,
  type Guard,
  type GuardInput,
  Ops,
  Use,
  UseGuards,
  createWebApplication,
  type WebApplication,
} from '../../index.js'

/**
 * A controller bound with `@BindTo(...)`: the controller counterpart of `router.with(bindTo(...))`, carrying its
 * own plugin, guards and `@Catch` methods to the ops server that serves it.
 *
 * Isolated: a `@Controller` registers into the process-wide registry, so every application in this file serves it
 * and must install the server it is bound to.
 */

const listener = { host: '127.0.0.1', port: 0 }

class Teapot extends Error {}

@Injectable()
class TokenGuard implements Guard {
  guard(input: GuardInput): boolean {
    return input.context.req.header('x-token') === 'ok'
  }
}

@BindTo('admin')
@Use(() =>
  fp(
    async (instance: FastifyInstance) => {
      instance.addHook('onRequest', (_request, reply, done) => {
        reply.header('x-controller-plugin', 'yes')
        done()
      })
    },
    { name: 'decorated-controller-plugin' },
  ),
)
@UseGuards(TokenGuard)
@Controller('/decorated')
class DecoratedController {
  @Get('/')
  get(): unknown {
    return { decorated: true }
  }

  @Get('/teapot')
  teapot(): unknown {
    throw new Teapot()
  }

  @Catch(Teapot)
  caught(ctx: Context): ActionResult {
    return ctx.status(418).body({ caughtBy: 'controller' })
  }
}

void [TokenGuard, DecoratedController]

describe('a controller bound with @BindTo', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function started(): Promise<{ main: string; admin: string }> {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .server(() => ({ listener }))

    await app.run()

    return { main: app.address!.origin, admin: app.ops.get('admin')!.address!.origin }
  }

  it('is served only on its server, behind its own plugin and guard', async () => {
    const { main, admin } = await started()

    expect((await fetch(`${admin}/decorated`)).status).toBe(403)

    const allowed = await fetch(`${admin}/decorated`, { headers: { 'x-token': 'ok' } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('x-controller-plugin')).toBe('yes')
    expect(await allowed.json()).toEqual({ decorated: true })

    expect((await fetch(`${main}/decorated`, { headers: { 'x-token': 'ok' } })).status).toBe(404)
  })

  it('answers through its own @Catch method on the ops server', async () => {
    const { admin } = await started()

    const res = await fetch(`${admin}/decorated/teapot`, { headers: { 'x-token': 'ok' } })

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ caughtBy: 'controller' })
  })

  it('names the server serving it on its compiled group', async () => {
    await started()

    expect(app!.routeGroups.find(group => group.target === DecoratedController)?.boundTo).toBe('admin')
  })
})
