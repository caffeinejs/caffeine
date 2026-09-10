import type { AdapterRouteOptions } from './route_hooks.js'
import type { AnyRouteExtension } from './routing/programmatic/extension.js'

/**
 * Fastify's own route options, minus the ones the router owns.
 *
 * What is left is the whole of what Fastify accepts and this package does not decide: every lifecycle hook,
 * `errorHandler`, the validator and serializer compilers, `attachValidation`, `logLevel`, `constraints`, `version`,
 * `exposeHeadRoute`, `prefixTrailingSlash`.
 *
 * The omissions are the keys the adapter writes for itself: `method` and `url` come from the verb and the path,
 * `schema` from `.schema()`, `bodyLimit` from `.bodyLimit()`, `handlerTimeout` from `.timeout()`, and `config`
 * carries what the request handler reads to apply the route's status, content type, headers and authentication.
 * `handler` is written after these options are applied and could never take effect.
 */
export type FastifyRouteOptions = Omit<
  AdapterRouteOptions,
  'method' | 'url' | 'handler' | 'schema' | 'config' | 'bodyLimit' | 'handlerTimeout'
>

/**
 * The Fastify escape hatch: options passed to the route as the adapter registers it.
 *
 * For what the router has no opinion about and no reason to grow one — a lifecycle hook, a custom serializer, a
 * route-level log level. A hook set here keeps its place ahead of the hooks attached for guards, the request
 * scope and any route contributor.
 *
 * ```ts
 * uploads
 *   .post('/')
 *   .with(fst({ attachValidation: true, logLevel: 'debug' }))
 *   .handler(ctx => ...)
 * ```
 */
export function fst(options: FastifyRouteOptions): AnyRouteExtension {
  const entries = Object.entries(options)

  return (target: { options(key: string, value: unknown): unknown }) => {
    for (const [key, value] of entries) {
      target.options(key, value)
    }
  }
}
