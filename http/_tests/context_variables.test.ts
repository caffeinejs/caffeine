import { CaffeineIoC } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import { Args, Catch, type IContext, Controller, ContextState, Get, type MiddlewareFn, Router, $p } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

// Controllers are registered globally at decoration time and a container snapshots them when it is
// constructed, so every controller in this file is declared up front rather than inside the test that uses
// it.

type Vars = { tenant: string }

class ErrBoom extends Error {}

@Controller('/state')
class StateController {
  @Get('/read')
  @Args([$p.context()])
  read(ctx: IContext<Vars>) {
    return { tenant: ctx.state.get('tenant') ?? null }
  }

  @Get('/missing')
  @Args([$p.context()])
  missing(ctx: IContext<Vars>) {
    return { tenant: ctx.state.get('tenant') ?? null }
  }

  @Get('/identity')
  @Args([$p.context()])
  identity(ctx: IContext<Vars>) {
    return { same: ctx.state === ctx.state }
  }

  @Get('/slow')
  @Args([$p.context()])
  async slow(ctx: IContext<Vars>) {
    await new Promise(resolve => setTimeout(resolve, 20))
    return { tenant: ctx.state.get('tenant') ?? null }
  }

  @Get('/boom')
  boom(): never {
    throw new ErrBoom('boom')
  }

  @Catch(ErrBoom)
  onBoom(ctx: IContext<Vars>) {
    ctx.status(500).body({ tenant: ctx.state.get('tenant') ?? null })
  }
}
void [StateController]

/** Writes the tenant off a header, which is the shape a real tenancy middleware has. */
const tenancy: MiddlewareFn<Vars> = (ctx, next) => {
  const header = ctx.req.header('x-tenant')

  if (header !== undefined) {
    ctx.state.set('tenant', header)
  }

  return next()
}

function newApp() {
  const app = createWebApplication({ container: new CaffeineIoC() })
  app.use(tenancy, { hook: 'onRequest' })
  return app
}

describe('ContextState', () => {
  it('reads back undefined for a key nothing wrote', () => {
    const state = new ContextState<Vars>()

    expect(state.get('tenant')).toBeUndefined()
  })

  it('reads back what was written', () => {
    const state = new ContextState<Vars>()

    state.set('tenant', 'acme')

    expect(state.get('tenant')).toBe('acme')
  })
})

describe('request variables', () => {
  it('carries a value from a middleware to the handler', async () => {
    const application = newApp()
    await application.bootstrap()

    const response = await application.request('/state/read', { headers: { 'x-tenant': 'acme' } })

    expect(await response.json()).toEqual({ tenant: 'acme' })

    await application.close()
  })

  it('reads undefined on a request no middleware wrote to', async () => {
    const application = newApp()
    await application.bootstrap()

    const response = await application.request('/state/missing')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tenant: null })

    await application.close()
  })

  it('reaches an error handler, which serves the same context as the handler', async () => {
    const application = newApp()
    await application.bootstrap()

    const response = await application.request('/state/boom', { headers: { 'x-tenant': 'acme' } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ tenant: 'acme' })

    await application.close()
  })

  it('hands out one state per request, not a fresh one per access', async () => {
    const application = newApp()
    await application.bootstrap()

    const response = await application.request('/state/identity')

    expect(await response.json()).toEqual({ same: true })

    await application.close()
  })

  it('keeps concurrent requests from seeing each other values', async () => {
    const application = newApp()
    await application.bootstrap()

    const [first, second] = await Promise.all([
      application.request('/state/slow', { headers: { 'x-tenant': 'acme' } }),
      application.request('/state/slow', { headers: { 'x-tenant': 'globex' } }),
    ])

    expect(await first.json()).toEqual({ tenant: 'acme' })
    expect(await second.json()).toEqual({ tenant: 'globex' })

    await application.close()
  })

  it('carries a value into a programmatic handler', async () => {
    const pets = new Router('/pets').vars<Vars>()
    const routes = pets.get('/', ctx => ({ tenant: ctx.state.get('tenant') ?? null }))

    const application = newApp().mount(routes)
    await application.bootstrap()

    const response = await application.request('/pets', { headers: { 'x-tenant': 'acme' } })

    expect(await response.json()).toEqual({ tenant: 'acme' })

    await application.close()
  })
})
