import {
  type BootstrapKit,
  ErrFeatureNotInstalled,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import { type AnyClass, reflect } from '@caffeinejs/di'
import { Keys } from '@caffeinejs/http'
import { getRouteGroup } from '@caffeinejs/http/decorators/registrar'
import { errMessage } from '@caffeinejs/std/err'

import { Retry } from '../aop/annotations.js'
import { kResilienceHTTP } from '../aop/feature.js'
import { ResilienceRegistry } from '../aop/registry.js'
import { ErrInvalidOption } from '../errors.js'

/** What `ResilienceHTTP(h => h.config(...))` takes. */
export interface ResilienceHTTPConfig {
  /** The HTTP methods a handler may retry without declaring itself repeatable. */
  readonly retryableMethods?: readonly string[]
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

/**
 * Refuses, at `bootstrap()`, a `@Retry` on a controller handler that running twice could harm.
 *
 * A handler may carry `@Retry` only when every HTTP method routed to it is retryable, `GET`, `HEAD` and `OPTIONS`
 * by default, or when it declares itself repeatable with `@Retry(name, { repeatable: true })`. A route that reads its
 * body as a stream is refused even then. `@Retry` on a service a handler calls is not checked.
 */
export class ResilienceHTTPBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience-http'

  #config: Partial<ResilienceHTTPConfig> | undefined
  #retryableMethods: readonly string[] | undefined

  config(config: Partial<ResilienceHTTPConfig>): this {
    this.#config = config
    return this
  }

  /** Replaces the methods a handler may retry without declaring itself repeatable, such as `'PUT'`, `'DELETE'`. */
  retryableMethods(...methods: string[]): this {
    this.#retryableMethods = methods
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    kit.container.bind(kResilienceHTTP, t => t.toValue(true))
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (!kit.container.has(ResilienceRegistry)) {
      throw new ErrFeatureNotInstalled(
        'resilience',
        'Install Resilience() from @caffeinejs/resilience/aop next to ResilienceHTTP()',
      )
    }

    const methods = this.#retryableMethods ?? this.#config?.retryableMethods ?? SAFE_METHODS
    const retryableMethods = new Set(methods.map(method => method.toUpperCase()))
    for (const { key, binding } of kit.container.getBindingsByLabel(Keys.CONTROLLER)) {
      // The routes are the key's, as the HTTP package builds them; the handlers that run are the bound class's.
      const group = typeof key === 'function' ? getRouteGroup(key)?.toRouteGroup() : undefined
      const cls = (binding.type ?? key) as AnyClass
      if (group === undefined) {
        continue
      }

      for (const route of group.routes) {
        const retry = reflect.effective(cls, Retry, route.name as never)
        if (retry === undefined) {
          continue
        }

        const where = `${cls.name}.${String(route.name)}`
        let path = `${group.prefix ?? ''}${group.path}${route.path}`
        while (path.length > 1 && path.endsWith('/')) {
          path = path.slice(0, -1)
        }
        path ||= '/'
        if (route.bodyAs === 'stream') {
          throw new ErrInvalidOption(
            errMessage(
              `Cannot retry "${route.method.map(method => method.toUpperCase()).join(',')} ${path}" (${where}): the route reads its body as a stream, which cannot be read twice`,
            )
              .solutions(
                `Move @Retry('${retry.name}') to the outbound client method the handler calls`,
                'Read the body as a buffer instead of a stream',
              )
              .reference('@caffeinejs/resilience', ErrInvalidOption)
              .build(),
          )
        }

        if (retry.repeatable) {
          continue
        }

        for (const method of route.method.map(verb => verb.toUpperCase())) {
          if (!retryableMethods.has(method)) {
            throw new ErrInvalidOption(
              errMessage(`Cannot retry "${method} ${path}" (${where}): ${method} is not a retryable method`)
                .solutions(
                  `Move @Retry('${retry.name}') to the outbound client method the handler calls`,
                  `Declare the handler repeatable with @Retry('${retry.name}', { repeatable: true }) if running it twice is safe`,
                  `Allow ${method} with ResilienceHTTP(h => h.retryableMethods(...)) if every ${method} handler is safe to replay`,
                )
                .reference('@caffeinejs/resilience', ErrInvalidOption)
                .build(),
            )
          }
        }
      }
    }
  }
}

/**
 * Installs the HTTP replay check for the resilience annotations: a `@Retry` on a controller handler for a method other
 * than `GET`, `HEAD` or `OPTIONS` fails `bootstrap()`, unless the handler declares itself repeatable or the method is
 * allowed with `retryableMethods(...)`.
 *
 * It needs `Resilience()`, and `Resilience()` needs it once any controller carries `@Retry`.
 *
 * @throws {@link ErrInvalidOption} at `bootstrap()` naming the route, the handler and the method.
 */
export function ResilienceHTTP<C = unknown>(configure?: FeatureConfigurer<ResilienceHTTPBuilder<C>, C>): Feature<C> {
  return new ResilienceHTTPBuilder<C>(configure as never)
}
