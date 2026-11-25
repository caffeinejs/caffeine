import { MiddlewarePipeline } from './core/middleware/pipeline.js'
import type { RouteOptionsLevel } from './core/routing/options.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import { ScopeChains } from './core/routing/scope_chain.js'
import type { HTTPPluginFactory, HTTPSetupContext } from './plugin.js'
import type { ServerConfigurer } from './server.js'

/** What `.basePath(...)` takes besides a string: resolved once at start-up, like a `.server(...)` configurer. */
export type BasePathConfigurer<C> = (
  context: Omit<HTTPSetupContext<C>, 'server'>,
) => string | undefined | Promise<string | undefined>

/**
 * What one server is built from: its settings, its plugins and its middleware. The application's own server and
 * every listener, `.listener(name, ...)`, are each one of these, built the same way; a server serves the routers
 * mounted on it and the controllers bound to it with `@BindTo`, and the application's own server also the unbound
 * ones.
 */
export class ServerDefinition<C = unknown> {
  /** What its `.server(...)` calls return, in call order. */
  readonly server: ServerConfigurer<object, C>[] = []
  /** Its `.with(...)` factories, in call order. */
  readonly plugins: HTTPPluginFactory<C>[] = []
  /** What its `.use(...)` and `.useFn(...)` calls registered: resolved, and sealed, by its server's setup. */
  readonly middlewares = new MiddlewarePipeline()
  /** What its `.basePath(...)` set; the last call wins. */
  basePath: BasePathConfigurer<C> | undefined
  /** Its `.mount(...)` routers, in call order. */
  readonly routers: AnyRouter[] = []
  /**
   * Each mount place's own route-option levels, kept from the walk that compiles its routers to the one that compiles
   * what their plugins mount, so a router's configurer runs once per place.
   */
  readonly levels = new ScopeChains<RouteOptionsLevel[] | undefined>()

  /** @param name - The listener's name; `undefined` for the application's own server. */
  constructor(readonly name?: string) {}
}
