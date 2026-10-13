import type { FastifyPluginAsync, FastifyPluginCallback, FastifyPluginOptions } from 'fastify'

import type { AdapterExtensionFactory, AdapterTypes, HTTPSetupContext } from './adapter.js'
import type { FastifyRouterTypes } from './fastify_adapter.js'

/**
 * Any Fastify plugin, callback- or async-style — a bare third-party one (`@fastify/cors`, `@fastify/cookie`,
 * …) as much as one this package or a feature authors. What the Fastify adapter installs.
 */
export type AnyFastifyPlugin = FastifyPluginCallback | FastifyPluginAsync

/**
 * A plugin and the options to register it with, handed back together by the factory that built them.
 *
 * The options are built inside the factory, so they can come from the application's configuration or from
 * something resolved out of the container. Handing the plugin over rather than a wrapper closing over its
 * options is what keeps the plugin's own `fastify-plugin` wrapping doing its job: a wrapper is encapsulated, and
 * the hooks and decorations of the plugin inside it stay there.
 *
 * The plugin's own options type is not carried across to `options`, since `.with(...)` is not generic in it and
 * making it so would decide the application's configuration type from the wrong argument. Write
 * `options satisfies FastifyStaticOptions` where the exact shape matters. This is also the only form that takes
 * a plugin whose options are *required*, such as `@fastify/static` and its `root`: {@link AnyFastifyPlugin}
 * describes one that can be registered with none.
 */
export type FastifyPluginWithOptions = readonly [
  plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>,
  options: FastifyPluginOptions,
]

/** What the Fastify adapter installs: a plugin, or a plugin together with the options to register it with. */
export type FastifyExtension = AnyFastifyPlugin | FastifyPluginWithOptions

/**
 * Keys the server half of a framework built-in: the extension `WebApplication` itself puts in a head slot,
 * ahead of everything `.with(...)` registers. Symbol-keyed so it stays off the fluent surface the
 * `.cookie(...)` and `.errorHandling(...)` callbacks see.
 */
export const kServerExtension = Symbol('caffeine.http.server.extension')

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
 * - With `.with(...)` on the application, or `Ops(name, o => o.with(...))`, it registers in that slot, before the
 *   adapter builds the server: what it mounts that server serves, and its middleware joins that server's pipeline.
 * - With `router.with(...)`, it registers once during start-up, before routing is built: what it mounts nests under
 *   the router, and its middleware runs in front of the router's routes, with paths relative to the router.
 * - With `@Use(...)` on a controller, its middleware runs in front of the controller's routes, with paths relative
 *   to the controller. It cannot mount: a class has no children to nest routers under.
 *
 * A plain `HTTPPlugin` is written for no adapter: it mounts only routers bound to none, `new Router(...)`, names no
 * hook, and runs on any adapter. `HTTPPlugin<FastifyRouterTypes>` may mount `newRouter()` routers and name Fastify
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
 * app.install(Ops('admin', o => o.with(() => new Metrics())))
 * ```
 */
export abstract class HTTPPlugin<T extends AdapterTypes = never> {
  /** Phantom — names the adapter this plugin is written for, `never` for none. Never assigned, never read. */
  declare readonly __adapter?: T

  abstract register(context: HTTPSetupContext<unknown, T>): void | Promise<void>
}

/**
 * Produces a Fastify plugin from what the application resolved at start-up: its configuration, its container and
 * its logger. What `.with(...)` takes on a Fastify application, and how a third-party Fastify plugin is
 * configured from the application's own settings.
 *
 * A plugin taking options is handed back **with** them, as a pair, rather than wrapped in a plugin that closes
 * over them. `@fastify/cors` and every other official plugin already wraps itself in `fastify-plugin`, so
 * registering one directly is what puts its hooks on every route; a wrapper written only to carry the options
 * would be encapsulated, and the plugin inside it would reach no routes at all.
 *
 * A plugin needing nothing from the context is written `.with(() => myPlugin)` — `myPlugin` itself may be
 * callback-style or async, this package's own or a third party's untouched.
 *
 * `.with(...)` also takes a factory returning an {@link HTTPPlugin}, typed `AdapterExtensionFactory<HTTPPlugin, C>`,
 * when the plugin needs nothing from Fastify: its `register` runs in that slot. Either kind of factory's context
 * carries `app`, typed for Fastify here, which mounts routers and adds middleware where the `.with(...)` was
 * written.
 *
 * Called once, after `container.init()`, so `container.get(...)` is legal here. Its slot is where the `.with(...)`
 * call was written, so an `await` inside the factory cannot reorder it relative to the plugins around it.
 *
 * Encapsulation is the plugin author's to decide, exactly as it is for `@fastify/cors` or any other plugin.
 * Wrap it in `fastify-plugin` and its hooks and decorations apply to the context it was registered in; leave
 * it unwrapped and they stay inside the plugin, covering only what the plugin itself registered. Which context
 * that is depends on who registered it, and the plugin does not have to know: the application registers it on
 * the root server, and a router or a controller registers it inside that route group's own context. One
 * `fp`-wrapped plugin therefore serves both — it covers every route, or that group's routes, according to
 * where it was asked for.
 *
 * The container is reached off the instance itself — `instance.$container`, decorated before any plugin
 * registers and inherited into every route group's own context. The compiled routes register after every
 * plugin: one that needs them adds an `onRoute` hook and reads `routeOptions.config.$caffeine.compiled`, which
 * carries the route and the group it was compiled in, or calls {@link collectRouteGroups}.
 *
 * ```ts
 * .with(({ config }) => [fastifyCors, config.app.cors.options])
 * .with(({ config, container }) => [rateLimit, { redis: container.get(Redis), ...config.app.limits }])
 * .with(() => cors)
 * ```
 */
export type HTTPPluginFactory<C = unknown> = AdapterExtensionFactory<FastifyExtension, C, FastifyRouterTypes>

/**
 * Authors a plugin's options through its builder, handed the same {@link HTTPSetupContext} the factory that
 * runs it was given — so a plugin's settings can come from the application's configuration or from something
 * it resolves out of the container.
 *
 * Runs while the factory builds the plugin, after `container.init()`, so `container.get(...)` is legal and
 * `container.bind(...)` is not. A feature's callback is `FeatureConfigurer` from `@caffeinejs/std` instead,
 * which runs earlier and binds rather than resolves.
 *
 * ```ts
 * .with(HTTPCaching((b, { container }) => b.store(container.get(RedisCache))))
 * ```
 */
export type HTTPPluginConfigurer<B, C = unknown> = (
  builder: B,
  context: HTTPSetupContext<C, FastifyRouterTypes>,
) => void

const kPluginMeta = Symbol.for('plugin-meta')

/** The name `fastify-plugin` stamped on `plugin`, or `undefined` for one that was never wrapped with it. */
export function pluginName(plugin: AnyFastifyPlugin): string | undefined {
  return (plugin as unknown as Record<symbol, { name?: string } | undefined>)[kPluginMeta]?.name
}
