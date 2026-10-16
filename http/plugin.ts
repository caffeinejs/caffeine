import type { IAdapterTypes, HTTPSetupContext } from './adapter.js'

/**
 * A server plugin written against Caffeine alone: what a `.with(...)` factory returns when the plugin needs nothing
 * from Fastify.
 *
 * {@link register} does the work a Fastify plugin function would, handed the same {@link HTTPSetupContext} the
 * factory got: `context.container` resolves, `context.hasFeature(name)` lets a plugin that depends on a feature
 * refuse a missing one with `ErrFeatureNotInstalled`, and `context.app` mounts routers and adds middleware. Never
 * deduplicated: two factories register two plugins. A package exporting one types its factory
 * `AdapterExtensionFactory<HTTPPlugin, C>`.
 *
 * Where it is registered decides what `context.app` reaches:
 *
 * - With `.with(...)` on the application, or `Listener(name, l => l.with(...))`, it registers in that slot, before the
 *   adapter builds the server: what it mounts that server serves, and its middleware joins that server's pipeline.
 * - With `router.with(...)`, it registers once during start-up, before routing is built: what it mounts nests under
 *   the router, and its middleware runs in front of the router's routes, with paths relative to the router.
 * - With `@Use(...)` on a controller, its middleware runs in front of the controller's routes, with paths relative
 *   to the controller. It cannot mount: a class has no children to nest routers under.
 *
 * A plain `HTTPPlugin` is written for no adapter: it mounts only routers bound to none, `new Router(...)`, names no
 * hook, and runs on any adapter. `HTTPPlugin<RouterTypes>` may mount `newRouter()` routers and name Fastify
 * hooks, and only Fastify applications and routers take it. A plugin that needs Fastify itself returns a Fastify
 * plugin from its factory, which may still mount and add middleware through the factory's own context.
 *
 * ```ts
 * class Metrics extends HTTPPlugin {
 *   register({ app, container }: HTTPSetupContext): void {
 *     const registry = container.get(MetricsRegistry)
 *     app.mount(new Router('/metrics').get('/', () => registry.render()))
 *   }
 * }
 *
 * app.with(() => new Metrics())
 * app.install(Listener('admin', l => l.with(() => new Metrics())))
 * ```
 */
export abstract class HTTPPlugin<T extends IAdapterTypes = never> {
  /** Phantom — names the adapter this plugin is written for, `never` for none. Never assigned, never read. */
  declare readonly __adapter?: T

  abstract register(context: HTTPSetupContext<unknown, T>): void | Promise<void>
}
