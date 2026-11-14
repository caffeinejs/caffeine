import { expectTypeOf } from 'vitest'

import { type AnyAdapterTypes, type AnyRouter, Router, type SendPayload } from '../../../index.js'

/**
 * `AnyRouter` is what a plugin's `context.app.mount` and the test client take: a router stays one whatever its path,
 * routes and dependencies type it as. Nothing at run time checks it, so `npm run test:typecheck` is the test.
 */

class Greeter {
  greet(): string {
    return 'hi'
  }
}

const typed = new Router('/pets')
  .inject({ greeter: Greeter })
  .get('/:id')
  .handler((ctx, deps) => ({ id: ctx.req.param().id, greeting: deps.greeter.greet() }))

expectTypeOf(typed).toExtend<AnyRouter>()
expectTypeOf(new Router()).toExtend<AnyRouter>()

// @ts-expect-error — a list of routers is not a router.
const _list: AnyRouter = [typed]

// A hook is typed by its point: onSend gets the payload, a router's variables reach its context, and a router bound to
// no adapter still sees a usable platform.
new Router('/hooks')
  .vars<{ tenant: string }>()
  .hook('onSend', (ctx, payload) => {
    expectTypeOf(payload).toEqualTypeOf<SendPayload>()
    expectTypeOf(ctx.state.get('tenant')).toEqualTypeOf<string | undefined>()
  })
  .hook('onRequest', ctx => {
    expectTypeOf(ctx.platform).toEqualTypeOf<AnyAdapterTypes['platform']>()
  })
  .get('/')
  .hook('onError', (_ctx, err) => {
    expectTypeOf(err).toEqualTypeOf<Error>()
  })
  .handler(() => 'ok')

// @ts-expect-error -- onRoute is a server hook: it is added on an application, a listener or a plugin
new Router('/hooks').hook('onRoute', () => undefined)
