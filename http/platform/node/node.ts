import { WebApplication, type WebApplicationOptions } from '../../application.js'
import { Router } from '../../core/routing/programmatic/programmatic.js'
import { nodeAdapterFactory, type NodeAdapterTypes } from './adapter.js'

/**
 * Creates the Node application: served by the web-standards engine on node:http, node:https or node:http2, as
 * `.server(...)` says, and listening once `run()` is called.
 *
 * ```ts
 * const app = createWebApplication({ config }).server(() => ({ listen: { port: 3000 } })).mount(pets)
 * const { address } = await app.run()
 * ```
 *
 * `ctx.req.raw` is a `Request` whose URL follows the socket and the `Host` header, while `ctx.req.host` and
 * `ctx.req.protocol` follow `trustProxy`. A handler typed with a plain `IContext` sees the `platform` types of every
 * engine application the program loads: reach Node's request through a router from {@link newRouter}, or narrow on
 * `ctx.platform.name === 'node'`.
 */
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): WebApplication<NodeAdapterTypes, never, never, TConfig> {
  return new WebApplication(nodeAdapterFactory(), options)
}

/** A {@link Router} bound to the Node application: its handlers' `ctx.platform` is Node's request and response. */
export function newRouter<GP extends string = ''>(
  path?: GP,
): Router<Record<never, never>, Record<never, never>, undefined, GP, never, NodeAdapterTypes> {
  return new Router<Record<never, never>, Record<never, never>, undefined, GP, never, NodeAdapterTypes>(path)
}
