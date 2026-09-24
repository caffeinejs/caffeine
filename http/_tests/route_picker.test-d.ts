import { Controller, Get, Args, $p, type Context } from '../index.js'

/**
 * A picker whose function annotates the request it reads is the only way to reach something the built-ins do
 * not expose, and it used to fail overload resolution with `TS2769`: `ParameterPickOptions` holds `R` in a
 * parameter position, so it is contravariant in it, and a list typed `ParameterPickOptions<unknown>[]` is the
 * rejecting end. Nothing at run time can fail when that drifts back, so `npm run test:typecheck` is the test.
 */

interface WithContext {
  httpContext: Context
}

@Controller('/callers')
class CallersController {
  // The reported case.
  @Get('/annotated')
  @Args([$p.pick((req: WithContext) => req.httpContext.user)])
  annotated(_user: unknown): unknown {
    return null
  }

  // An annotated pick sits alongside the built-ins in the same list.
  @Get('/mixed')
  @Args([$p.pick((req: WithContext) => req.httpContext.user), $p.param('id'), $p.body()])
  mixed(_user: unknown, _id: unknown, _body: unknown): unknown {
    return null
  }

  // The unannotated form, which always worked.
  @Get('/inferred')
  @Args([$p.pick(req => (req as WithContext).httpContext.user)])
  inferred(_user: unknown): unknown {
    return null
  }

  // A built-in wrapped in `map` — its declared request type must stay assignable too.
  @Get('/mapped')
  @Args([$p.map($p.context(), (ctx: Context) => ctx.user)])
  mapped(_user: unknown): unknown {
    return null
  }

  @Get('/user')
  @Args([$p.user()])
  user(_user: unknown): unknown {
    return null
  }
}

void CallersController
