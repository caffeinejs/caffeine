import type { Feature } from '@caffeinejs/std'

import type { BuilderOf, ScopedFeatureInstall } from '../plugin.js'

const FeatureRegistry = new WeakMap<Function, ScopedFeatureInstall[]>()

/**
 * Installs a feature whose plugin is registered inside this controller's Fastify context.
 *
 * The controller counterpart of `router.extend(...)`: the plugin runs in front of this controller's routes
 * and nowhere else. The feature itself is installed on the application, so it declares its configuration and
 * bootstraps exactly once — using the same {@link Feature.name} here and on the application builder is the
 * duplicate it looks like, and two controllers wanting different settings install two instances of the
 * feature (`cors()` and `cors('admin')`).
 *
 * The configure callback sees `unknown` where a `.config(c => …)` selector would read the application's
 * schema: a controller is declared without knowing which application it will be resolved into.
 *
 * ```ts
 * @Use(cors('admin'), c => c.origin('https://admin.example'))
 * @Controller('/admin')
 * class AdminController {}
 * ```
 */
export function Use<F extends Feature>(
  feature: F,
  configure?: (builder: BuilderOf<F>) => void,
): (target: Function, context: ClassDecoratorContext) => void {
  return function (target: Function): void {
    let installs = FeatureRegistry.get(target)
    if (installs === undefined) {
      installs = []
      FeatureRegistry.set(target, installs)
    }

    // Decorators apply bottom-up, so the list comes out in the order a reader sees the decorators only if it
    // is reversed. Prepending keeps the written order.
    installs.unshift({ feature, configure: configure as ((builder: never) => void) | undefined })
  }
}

/** What `@Use` recorded on `target`, in the order the decorators were written. */
export function controllerFeatures(target: Function): readonly ScopedFeatureInstall[] {
  return FeatureRegistry.get(target) ?? []
}
