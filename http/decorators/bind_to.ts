import { kBindTo } from '../binding.js'
import { configureRouteGroup } from './registrar/registrar.js'

/**
 * Binds a controller to the server added under `name` — `.listener('admin', ...)` — which serves its routes in place
 * of the application's own server. A name no installed server has is refused at start-up.
 *
 * ```ts
 * @BindTo('admin')
 * @Controller('/metrics')
 * class MetricsController {}
 * ```
 */
export function BindTo(name: string): (target: Function, context: ClassDecoratorContext) => void {
  return (target, context) =>
    configureRouteGroup(context, target, group => {
      group.label(kBindTo, name)
    })
}
