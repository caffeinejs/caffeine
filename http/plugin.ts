import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify'

import type { AdapterExtensionFactory } from './adapter_extension.js'

/**
 * Any Fastify plugin, callback- or async-style — a bare third-party one (`@fastify/cors`, `@fastify/cookie`,
 * …) as much as one this package or a feature authors. What the Fastify adapter installs.
 */
export type AnyFastifyPlugin = FastifyPluginCallback | FastifyPluginAsync

/**
 * Produces a Fastify plugin from what the application resolved at start-up: its configuration, its container and
 * its logger. What `.with(...)` takes on a Fastify application when the argument is a function, and how a
 * third-party Fastify plugin is configured from the application's own settings.
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
 * .with(({ config }) => corsPlugin(config.app.cors.options))
 * .with(({ config, container }) => rateLimitPlugin(container.get(Redis), config.app.limits))
 * .with(() => cors)
 * ```
 */
export type HTTPPluginFactory<C = unknown> = AdapterExtensionFactory<AnyFastifyPlugin, C>

const kPluginMeta = Symbol.for('plugin-meta')

/** The name `fastify-plugin` stamped on `plugin`, or `undefined` for one that was never wrapped with it. */
export function pluginName(plugin: AnyFastifyPlugin): string | undefined {
  return (plugin as unknown as Record<symbol, { name?: string } | undefined>)[kPluginMeta]?.name
}
