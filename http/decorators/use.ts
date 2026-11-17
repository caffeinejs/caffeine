import type { HTTPPluginFactory } from '../plugin.js'
import { configureRouteGroup } from './registrar/registrar.js'

/**
 * Installs a plugin in front of this controller's routes and nowhere else.
 *
 * The controller counterpart of `router.with(...)`. The factory is resolved once, during start-up, with the same
 * context the application's `.with(...)` factories get.
 *
 * The factory returns an `HTTPPlugin`: its middleware, added with `context.app.use(...)`, runs in front of this
 * controller's routes, a path relative to the controller. It cannot mount routers: a class has no children to
 * nest them under.
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
