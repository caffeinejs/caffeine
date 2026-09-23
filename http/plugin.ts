import type { FastifyPluginAsync, FastifyPluginCallback, FastifyPluginOptions } from 'fastify'

import type { AdapterExtensionFactory } from './adapter_extension.js'
import type { HTTPSetupContext } from './setup_context.js'

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
 * Produces a Fastify plugin from what the application resolved at start-up: its configuration, its container and
 * its logger. What `.with(...)` takes on a Fastify application when the argument is a function, and how a
 * third-party Fastify plugin is configured from the application's own settings.
 *
 * A plugin taking options is handed back **with** them, as a pair, rather than wrapped in a plugin that closes
 * over them. `@fastify/cors` and every other official plugin already wraps itself in `fastify-plugin`, so
 * registering one directly is what puts its hooks on every route; a wrapper written only to carry the options
 * would be encapsulated, and the plugin inside it would reach no routes at all.
 *
 * A plugin needing nothing from the context is written `.with(() => myPlugin)` — `myPlugin` itself may be
 * callback-style or async, this package's own or a third party's untouched.
 *
 * Called once, after `container.init()`, so `container.get(...)` is legal here. Its slot is where the `.with(...)`
 * call was written, so an `await` inside the factory cannot reorder it relative to `.authentication(...)`.
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
 * plugin: one that needs them adds an `onRoute` hook and reads `routeOptions.config.$caffeine`, which carries
 * the route and the group it was compiled in, or calls {@link collectRouteGroups}.
 *
 * ```ts
 * .with(({ config }) => [fastifyCors, config.app.cors.options])
 * .with(({ config, container }) => [rateLimit, { redis: container.get(Redis), ...config.app.limits }])
 * .with(() => cors)
 * ```
 */
export type HTTPPluginFactory<C = unknown> = AdapterExtensionFactory<FastifyExtension, C>

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
 * .with(health((h, { config }) => h.config(config.app.health)))
 * .with(HTTPCaching((b, { container }) => b.store(container.get(RedisCache))))
 * ```
 */
export type HTTPPluginConfigurer<B, C = unknown> = (builder: B, context: HTTPSetupContext<C>) => void

const kPluginMeta = Symbol.for('plugin-meta')

/** The name `fastify-plugin` stamped on `plugin`, or `undefined` for one that was never wrapped with it. */
export function pluginName(plugin: AnyFastifyPlugin): string | undefined {
  return (plugin as unknown as Record<symbol, { name?: string } | undefined>)[kPluginMeta]?.name
}
