import { kBindTo } from '../binding.js'
import type { RouteGroupExtension } from '../routing/extension.js'
import { configureRouteGroup } from './registrar/registrar.js'

/**
 * Binds a router to the server installed under `name` — `.install(Ops('admin', ...))` — which serves its routes in
 * place of the application's own server.
 *
 * A router nested in a bound one is served where its parent is: binding it to another server is refused at
 * start-up, and so is a name no installed server has. Calling it twice on one router keeps the last name.
 *
 * ```ts
 * newRouter('/ops').with(bindTo('admin'))
 * ```
 */
export function bindTo(name: string): RouteGroupExtension {
  return group => {
    group.label(kBindTo, name)
  }
}

/**
 * Binds a controller to the server installed under `name` — `.install(Ops('admin', ...))` — which serves its routes
 * in place of the application's own server. The controller counterpart of {@link bindTo}.
 *
 * ```ts
 * @BindTo('admin')
 * @Controller('/metrics')
 * class MetricsController {}
 * ```
 */
export function BindTo(name: string): (target: Function, context: ClassDecoratorContext) => void {
  return (target, context) => configureRouteGroup(context, target, bindTo(name))
}
