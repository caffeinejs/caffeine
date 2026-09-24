import type { AdapterExtensionFactory, AnyAdapterExtension } from '../adapter.js'

const PluginRegistry = new WeakMap<Function, AdapterExtensionFactory<AnyAdapterExtension>[]>()

/**
 * Installs an adapter extension — under Fastify, a plugin — in front of this controller's routes and nowhere else.
 *
 * The controller counterpart of `router.plugin(...)`. The factory is resolved once, during start-up, with the same
 * context the application's `.with(...)` factories get.
 *
 * A controller is declared without knowing which application it will be resolved into, so the configuration
 * there is typed `unknown`, and the factory may return what any registered adapter installs. Nothing checks
 * that against the application's adapter before start-up; the Fastify adapter refuses anything but a plugin
 * function there. Reach for a container binding when a controller-scoped plugin needs settings of its own.
 *
 * ```ts
 * @Use(() => corsPlugin({ origin: 'https://admin.example' }))
 * @Controller('/admin')
 * class AdminController {}
 * ```
 */
export function Use(
  factory: AdapterExtensionFactory<AnyAdapterExtension>,
): (target: Function, context: ClassDecoratorContext) => void {
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
export function controllerPlugins(target: Function): readonly AdapterExtensionFactory<AnyAdapterExtension>[] {
  return PluginRegistry.get(target) ?? []
}
