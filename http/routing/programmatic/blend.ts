import { Router } from './router.js'
import type { AdapterOf, ConfigOf, DepsOf, RoutesOf, VarsOf } from './types.js'

/**
 * Combines routers into one, carrying every route they declare in its type.
 *
 * What makes routes written as separate statements usable as a unit. A verb chain closed by `.handler()` gives
 * back the router typed with that one route, so each statement leaves behind a handle on the same group — blending
 * the handles unions what they know. The routers are added once each, so naming the same one twice is harmless.
 *
 * ```ts
 * const pets = new Router('/pets')
 * const list = pets.get('/').handler(() => repository.all())
 * const add = pets.post('/').handler(ctx => repository.add(ctx.req.body()))
 *
 * export const petsRouter = blend(list, add)
 * ```
 *
 * The result mounts and nests like any other router, and adds no path of its own. To put the routes under a
 * prefix, mount them: `new Router('/api').mount(list, add)`.
 */
export function blend<const RS extends ReadonlyArray<Router<any, any, any, any, any, any>>>(
  ...routers: RS
): Router<
  VarsOf<RS[number]>,
  ConfigOf<RS[number]>,
  DepsOf<RS[number]>,
  '',
  RoutesOf<RS[number]>,
  AdapterOf<RS[number]>
> {
  // The mount re-bases under the empty path, which is the identity — a step the compiler will not take on its own
  // while the routes are still a type parameter. The mount goes through a router that accepts any binding, and the
  // result carries every binding the routers had: one bound to another adapter then fails where it is mounted.
  return new Router<VarsOf<RS[number]>, ConfigOf<RS[number]>, DepsOf<RS[number]>, '', never, any>().mount(
    ...routers,
  ) as unknown as Router<
    VarsOf<RS[number]>,
    ConfigOf<RS[number]>,
    DepsOf<RS[number]>,
    '',
    RoutesOf<RS[number]>,
    AdapterOf<RS[number]>
  >
}
