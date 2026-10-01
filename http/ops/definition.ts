import type { ServerConfigurer } from '../adapter.js'
import type { FastifyTypes } from '../fastify_adapter.js'
import type { FastifyMiddlewareHook } from '../middleware/fastify.js'
import type { MiddlewarePipeline } from '../middleware/pipeline.js'
import type { HTTPPluginFactory } from '../plugin.js'
import type { RouteAuthz } from '../routing/spec.js'

/**
 * What one `Ops(name, ...)` declared, for the application to build the server from.
 *
 * Never bound under its own class: each is bound under a key of its own, extending this one, and the application
 * collects them all with `container.getManyOptional(OpsDefinition)`.
 */
export class OpsDefinition {
  constructor(
    readonly name: string,
    /** What its `.server(...)` calls return, in call order. */
    readonly server: readonly ServerConfigurer<FastifyTypes>[],
    /** What its `.authorize(...)` calls declared, folded. `undefined` when it declared nothing. */
    readonly authz: RouteAuthz | undefined,
    /** Its `.with(...)` factories, in call order. */
    readonly plugins: readonly HTTPPluginFactory[],
    /** What its `.use(...)` and `.useFn(...)` calls registered: resolved, and sealed, by its server's setup alone. */
    readonly middlewares: MiddlewarePipeline<FastifyMiddlewareHook>,
  ) {}
}
