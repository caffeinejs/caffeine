import type { HTTPPluginFactory } from '../plugin.js'
import { configureRouteGroup } from './registrar/registrar.js'

/**
 * Installs a plugin in front of this controller's routes and nowhere else.
 *
 * The controller counterpart of `router.with(...)`. The factory runs during start-up on the server serving the
 * controller, after that server's routers' plugins, with `context.server` scoped to the controller: its routes, and
 * nothing a sibling controller serves.
 *
 * The factory returns an `HTTPPlugin`: its middleware, added with `context.server.use(...)`, runs in front of this
 * controller's routes, a path relative to the controller, and what it mounts with `context.server.mount(...)` nests
 * under the controller, starting from its declarations.
 *
 * A controller is declared without knowing which application it will be resolved into, so the configuration
 * there is typed `unknown`. Reach for a container binding when a controller-scoped plugin needs settings of its own.
 *
 * ```ts
 * @Use(authentication(g => g.name('admin')))
 * @Controller('/admin')
 * class AdminController {}
 * ```
 */
export function Use(factory: HTTPPluginFactory): (target: Function, context: ClassDecoratorContext) => void {
  return function (target: Function, context: ClassDecoratorContext): void {
    configureRouteGroup(context, target, spec => spec.plugin(factory))
  }
}
