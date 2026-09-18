import type { FastifyRouterTypes } from '../../fastify_types.js'
import { Router } from './router.js'

/**
 * A {@link Router} bound to the Fastify adapter: its `.plugin(...)` takes a Fastify plugin factory, and its
 * handlers' `ctx.platform` is Fastify's request and reply.
 *
 * `new Router(path)` builds one bound to no adapter, which mounts on any application and takes no plugin.
 *
 * ```ts
 * const pets = newRouter('/pets').plugin(() => corsPlugin({ origin: 'https://pets.example' }))
 * ```
 */
export function newRouter<GP extends string = ''>(
  path?: GP,
): Router<Record<never, never>, Record<never, never>, undefined, GP, never, FastifyRouterTypes> {
  return new Router<Record<never, never>, Record<never, never>, undefined, GP, never, FastifyRouterTypes>(path)
}
