import type { Container } from '@caffeinejs/di'
import { FeatureBuilder, type BootstrapKit, type Feature } from '@caffeinejs/std'
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
 * Which context that is depends on who installed the feature, and the plugin does not have to know: the
 * application registers it on the root server, and a router or a controller registers it inside that route
 * group's own context. One `fp`-wrapped plugin therefore serves both — it covers every route, or that
 * group's routes, according to where it was asked for.
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
 * Contributes a plugin from a feature's bootstrap hook.
 *
 * `BootstrapKit.extensions` is platform-neutral and accepts anything, so going through this is what gets the
 * contribution type-checked at the call site.
 */
export function registerPlugin(kit: BootstrapKit, plugin: HTTPPlugin): void {
  kit.extensions.register(plugin)
}

/**
 * A {@link FeatureBuilder} whose whole bootstrap is "produce the plugin".
 *
 * Extend this when the feature binds nothing else. A feature that also has container bindings to make
 * overrides `bootstrap` itself and calls {@link registerPlugin}.
 */
export abstract class HTTPFeatureBuilder<T, C = unknown> extends FeatureBuilder<T, C> {
  protected abstract plugin(kit: BootstrapKit): HTTPPlugin | Promise<HTTPPlugin>

  protected async bootstrap(kit: BootstrapKit): Promise<void> {
    registerPlugin(kit, await this.plugin(kit))
  }
}

/** The builder a {@link Feature} hands its `configure` callback. */
export type BuilderOf<F> = F extends Feature<infer B> ? B : never

/**
 * A feature a router or a controller installed, held until the application bootstraps.
 *
 * The feature is installed on the application like any other — one slice, one bootstrap — and only the
 * plugin it produces is scoped: the adapter registers it inside that route group's plugin context instead of
 * on the root server.
 */
export interface ScopedFeatureInstall {
  feature: Feature
  configure?: (builder: never) => void
}
