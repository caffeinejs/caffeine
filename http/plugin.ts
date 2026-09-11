import type { Container } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

import type { RouteGroup } from './route.js'

/**
 * What every Caffeine plugin is registered with.
 *
 * `routeGroups` is here rather than closed over because routing is built after the feature bootstrapped, and
 * `container` because a plugin registered into a route group's context has no other way to reach it.
 */
export type HTTPPluginOptions = {
  container: Container
  routeGroups: RouteGroup<any>[]
}

/**
 * A unit of start-up wiring: an ordinary Fastify plugin.
 *
 * Encapsulation is the author's to decide, exactly as it is for `@fastify/cors` or any other plugin. Wrap it
 * in `fastify-plugin` and its hooks and decorations apply to the context it was registered in; leave it
 * unwrapped and they stay inside the plugin, covering only what the plugin itself registered.
 *
 * Which context that is depends on who registered it, and the plugin does not have to know: the application
 * registers it on the root server, and a router or a controller registers it inside that route group's own
 * context. One `fp`-wrapped plugin therefore serves both — it covers every route, or that group's routes,
 * according to where it was asked for.
 *
 * ```ts
 * const plugin: HTTPPlugin = fp(async (instance, { container }) => {
 *   instance.addHook('onRequest', container.get(RateLimiter).hook)
 * }, { name: 'rate-limit' })
 * ```
 */
export type HTTPPlugin = FastifyPluginAsync<HTTPPluginOptions>

/** The plugin's arguments as one object, for the install functions that take the whole server and its input. */
export type HTTPPluginContext = HTTPPluginOptions & { server: FastifyInstance }

/**
 * Produces a plugin from the resolved configuration and the container. What `.extend(...)` takes in place of a
 * feature, and how a third-party Fastify plugin is configured from the application's own settings.
 *
 * Always a factory, never a bare plugin: both are functions, so accepting both would mean telling them apart
 * by arity. A plugin needing nothing from either argument is written `.extend(() => myPlugin)`.
 *
 * ```ts
 * .extend(c => corsPlugin(c.app.cors.options))
 * .extend((c, container) => rateLimitPlugin(container.get(Redis), c.app.limits))
 * ```
 */
export type HTTPPluginFactory<C = unknown> = (
  config: ConfigHandle<C>,
  container: Container,
) => HTTPPlugin | Promise<HTTPPlugin>

/**
 * Contributes a plugin from a feature's bootstrap hook.
 *
 * `BootstrapKit.extensions` is platform-neutral and accepts anything, so going through this is what gets the
 * contribution type-checked at the call site.
 */
export function registerPlugin(kit: BootstrapKit<any>, plugin: HTTPPlugin): void {
  kit.extensions.register(plugin)
}
