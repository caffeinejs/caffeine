import type { AdapterExtensionFactory, AnyAdapterExtension, AnyAdapterTypes } from '../adapter.js'
import type { HTTPPlugin } from '../plugin.js'

/** What `@Use(...)` takes: a factory for the adapter's plugin, or for an `HTTPPlugin`. */
type ControllerPluginFactory = AdapterExtensionFactory<
  AnyAdapterExtension | HTTPPlugin<AnyAdapterTypes>,
  unknown,
  AnyAdapterTypes
>

const PluginRegistry = new WeakMap<Function, ControllerPluginFactory[]>()

/**
 * Installs an adapter extension — under Fastify, a plugin — in front of this controller's routes and nowhere else.
 *
 * The controller counterpart of `router.with(...)`. The factory is resolved once, during start-up, with the same
 * context the application's `.with(...)` factories get.
 *
 * A factory may return an `HTTPPlugin` instead: its middleware, added with `context.app.use(...)`, runs in front of
 * this controller's routes, a path relative to the controller. It cannot mount routers: a class has no children to
 * nest them under.
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
export function Use(factory: ControllerPluginFactory): (target: Function, context: ClassDecoratorContext) => void {
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
export function controllerPlugins(target: Function): readonly ControllerPluginFactory[] {
  return PluginRegistry.get(target) ?? []
}
