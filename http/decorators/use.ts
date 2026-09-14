import type { HTTPPluginFactory } from '../plugin.js'

const PluginRegistry = new WeakMap<Function, HTTPPluginFactory[]>()

/**
 * Registers a Fastify plugin inside this controller's own Fastify context.
 *
 * The controller counterpart of `router.plugin(...)`: the plugin runs in front of this controller's routes and
 * nowhere else. The factory is resolved once, during start-up, with the resolved configuration and the
 * container — the same arguments the application's `.with(c => …)` gets.
 *
 * A controller is declared without knowing which application it will be resolved into, so the configuration
 * here is typed `unknown`. Reach for a container binding when a controller-scoped plugin needs settings of its
 * own.
 *
 * ```ts
 * @Use(() => corsPlugin({ origin: 'https://admin.example' }))
 * @Controller('/admin')
 * class AdminController {}
 * ```
 */
export function Use(factory: HTTPPluginFactory): (target: Function, context: ClassDecoratorContext) => void {
  return function (target: Function): void {
    let plugins = PluginRegistry.get(target)
    if (plugins === undefined) {
      plugins = []
      PluginRegistry.set(target, plugins)
    }

    // Decorators apply bottom-up, so the list comes out in the order a reader sees the decorators only if it
    // is reversed. Prepending keeps the written order.
    plugins.unshift(factory)
  }
}

/** What `@Use` recorded on `target`, in the order the decorators were written. */
export function controllerPlugins(target: Function): readonly HTTPPluginFactory[] {
  return PluginRegistry.get(target) ?? []
}
