import { expectTypeOf } from 'vitest'

import { type AnyRouter, Router } from '../../../index.js'

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
