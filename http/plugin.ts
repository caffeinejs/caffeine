import type { Container } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify'

/**
 * Any Fastify plugin, callback- or async-style — a bare third-party one (`@fastify/cors`, `@fastify/cookie`,
 * …) as much as one this package or a feature authors.
 */
type AnyFastifyPlugin = FastifyPluginCallback | FastifyPluginAsync

/**
 * Produces a plugin from the resolved configuration and the container. What `.plugin(...)` takes, and how a
 * third-party Fastify plugin is configured from the application's own settings.
 *
 * A plugin needing nothing from either argument is written `.plugin(() => myPlugin)` — `myPlugin` itself may
 * be callback-style or async, this package's own or a third party's untouched.
 *
 * App-level factories run from feature bootstrap, after `container.init()`, so `container.get(...)`
 * is legal here. The install slot is stamped when the feature bootstraps, so an `await` inside the factory
 * cannot reorder it relative to `.authentication(...)`.
 *
 * Encapsulation is the plugin author's to decide, exactly as it is for `@fastify/cors` or any other plugin.
 * Wrap it in `fastify-plugin` and its hooks and decorations apply to the context it was registered in; leave
 * it unwrapped and they stay inside the plugin, covering only what the plugin itself registered. Which context
 * that is depends on who registered it, and the plugin does not have to know: the application registers it on
 * the root server, and a router or a controller registers it inside that route group's own context. One
 * `fp`-wrapped plugin therefore serves both — it covers every route, or that group's routes, according to
 * where it was asked for.
 *
 * The container and the compiled routing are reached off the instance itself — `instance.$container` and
 * `instance.$routeGroups` — decorated before any plugin registers, and inherited into every route group's own
 * context the same way `instance.decorate(...)` always is.
 *
 * ```ts
 * .plugin(c => corsPlugin(c.app.cors.options))
 * .plugin((c, container) => rateLimitPlugin(container.get(Redis), c.app.limits))
 * .plugin(() => cors)
 * ```
 */
export type HTTPPluginFactory<C = unknown> = (
  config: ConfigHandle<C>,
  container: Container,
) => AnyFastifyPlugin | Promise<AnyFastifyPlugin>

/**
 * Contributes a plugin from a feature's bootstrap hook.
 *
 * `BootstrapKit.extensions` is platform-neutral and accepts anything, so going through this is what gets the
 * contribution type-checked at the call site.
 */
export function registerPlugin(kit: BootstrapKit<any>, plugin: AnyFastifyPlugin): void {
  kit.extensions.register(plugin)
}

/**
 * Decoration name `@caffeinejs/caching` stamps on a context once one of its plugin instances has registered
 * there, read back by the adapter's `@Cache`-without-caching-installed start-up refusal.
 *
 * A plain decoration rather than a `fastify-plugin` name: `@caffeinejs/caching` is meant to be installed more
 * than once (a different store per route group, say), so its plugin is deliberately unnamed and never
 * deduplicated by `assertPluginNotRegistered` — this is the replacement signal for "is it installed at all".
 */
export const CACHING_INSTALLED = '$cachingInstalled'

const kPluginMeta = Symbol.for('plugin-meta')

/** The name `fastify-plugin` stamped on `plugin`, or `undefined` for one that was never wrapped with it. */
export function pluginName(plugin: AnyFastifyPlugin): string | undefined {
  return (plugin as unknown as Record<symbol, { name?: string } | undefined>)[kPluginMeta]?.name
}
