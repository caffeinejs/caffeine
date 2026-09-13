import { DeferredCtor, Scopes, type Container, type InjectionToken } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { FastifyPluginAsync, FastifyPluginCallback } from 'fastify'

import { ErrConfiguration } from './error/common.js'
import { solutions } from './error/util.js'

/**
 * Any Fastify plugin, callback- or async-style — a bare third-party one (`@fastify/cors`, `@fastify/cookie`,
 * …) as much as one this package or a feature authors.
 */
type AnyFastifyPlugin = FastifyPluginCallback | FastifyPluginAsync

/**
 * Produces a plugin from the resolved configuration and the container. What `.plugin(...)` takes, and how a
 * third-party Fastify plugin is configured from the application's own settings.
 *
 * Always a factory, never a bare plugin: both are functions, so accepting both would mean telling them apart
 * by arity. A plugin needing nothing from either argument is written `.plugin(() => myPlugin)` — `myPlugin`
 * itself may be callback-style or async, this package's own or a third party's untouched. Write the factory
 * as an arrow: a `function` declaration is constructable and would be taken as a class token.
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
 * A container-managed source of a Fastify plugin. What `.plugin(key)` resolves, so a class token is a
 * real `Ctor` — the same reason `use()` takes `InjectionToken<Middleware>` rather than the middleware function.
 *
 * `create` receives the same arguments a factory does. Inject collaborators in the constructor; read
 * application settings from `config` when a library class cannot name them as a token.
 */
export interface HTTPPluginProvider<C = unknown> {
  create(config: ConfigHandle<C>, container: Container): AnyFastifyPlugin | Promise<AnyFastifyPlugin>
}

/**
 * Turns a `.plugin(...)` argument into the factory {@link HTTPPluginFeature} and scoped registration already
 * run. A token is not resolved here: configure is too early, so the returned factory `get()`s at bootstrap.
 *
 * Not part of the public API.
 */
export function asPluginFactory<C = unknown>(
  target: HTTPPluginFactory<C> | InjectionToken<HTTPPluginProvider<C>>,
): HTTPPluginFactory<C> {
  if (!isPluginToken(target)) {
    return target
  }

  const key = target
  return async (config, container) => {
    const name = typeof key === 'function' ? key.name : String(key)

    if (container.hasScopeInGraph(key, Scopes.REQUEST)) {
      throw new ErrConfiguration(
        `Cannot register plugin "${name}": it resolves from request scope` +
          solutions('Bind the plugin provider as a singleton', 'Plugins register once at start-up, not per request'),
      )
    }

    const value = container.get(key) as HTTPPluginProvider<C> | undefined
    if (value == null || typeof value.create !== 'function') {
      throw new ErrConfiguration(
        `Cannot register plugin "${name}": resolved value has no "create" method` +
          solutions(
            'Implement HTTPPluginProvider with a create(config, container) method',
            'Pass a factory (config, container) => plugin instead of a token',
          ),
      )
    }

    return value.create(config, container)
  }
}

function isPluginToken(value: unknown): value is InjectionToken<HTTPPluginProvider> {
  return (
    (typeof value === 'string' && value.length > 0) ||
    typeof value === 'symbol' ||
    value instanceof DeferredCtor ||
    isConstructable(value)
  )
}

function isConstructable(value: unknown): boolean {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}

/**
 * Contributes a plugin from a feature's bootstrap hook.
 *
 * `BootstrapKit.extensions` is platform-neutral and accepts anything, so going through this is what gets the
 * contribution type-checked at the call site.
 */
export function registerPlugin(kit: BootstrapKit<any>, plugin: AnyFastifyPlugin): void {
  kit.extensions.register(plugin)
}

const kPluginMeta = Symbol.for('plugin-meta')

/** The name `fastify-plugin` stamped on `plugin`, or `undefined` for one that was never wrapped with it. */
export function pluginName(plugin: AnyFastifyPlugin): string | undefined {
  return (plugin as unknown as Record<symbol, { name?: string } | undefined>)[kPluginMeta]?.name
}
