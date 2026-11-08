import {
  type BootstrapKit,
  ErrFeatureNotInstalled,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import type { AnyClass } from '@caffeinejs/di'
import { Keys, SAFE_METHODS } from '@caffeinejs/http'
import { getRouteGroup } from '@caffeinejs/http/decorators/registrar'
import { errMessage } from '@caffeinejs/std/err'

import { ResilienceRegistry } from '../aop/registry.js'
import { type MethodStages, stagesOf, written } from '../aop/stages.js'
import { ResilienceTransport } from '../aop/transport.js'
import { ErrInvalidOption } from '../errors.js'
import { isClientError } from './http.js'

// The route's path as a request names it: no trailing slash, and `/` for the root.
function routePath(joined: string): string {
  let path = joined
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  return path || '/'
}

// Refuses a retry on `route` that replaying the request would make unsafe.
function checkReplay(
  cls: AnyClass,
  path: string,
  route: { readonly name: string | symbol; readonly method: readonly string[]; readonly bodyAs?: string },
  { stages, repeatable }: MethodStages,
  retryableMethods: ReadonlySet<string>,
): void {
  const retry = stages.retry
  if (retry === undefined) {
    return
  }

  const where = `${cls.name}.${String(route.name)}`
  const methods = route.method.map(method => method.toUpperCase())
  if (route.bodyAs === 'stream') {
    throw new ErrInvalidOption(
      errMessage(
        `Cannot retry "${methods.join(',')} ${path}" (${where}): the route reads its body as a stream, which cannot be read twice`,
      )
        .solutions(
          `Move ${written(retry)} to the outbound client method the handler calls`,
          'Read the body as a buffer instead of a stream',
        )
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  const unsafe = repeatable ? undefined : methods.find(method => !retryableMethods.has(method))
  if (unsafe !== undefined) {
    throw new ErrInvalidOption(
      errMessage(`Cannot retry "${unsafe} ${path}" (${where}): ${unsafe} is not a retryable method`)
        .solutions(
          `Move ${written(retry)} to the outbound client method the handler calls`,
          `Declare the handler repeatable with @${retry.decorator}('${retry.preset}', { repeatable: true }) if running it twice is safe`,
          `Allow ${unsafe} with ResilienceHTTP(h => h.retryableMethods(...)) if every ${unsafe} handler is safe to replay`,
        )
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }
}

// Claims every controller for the replay check below, and tells its client errors apart with isClientError.
class HTTPTransport extends ResilienceTransport {
  readonly label = Keys.CONTROLLER

  isClientError(error: unknown): boolean {
    return isClientError(error)
  }
}

/** What `ResilienceHTTP(h => h.config(...))` takes. */
export interface ResilienceHTTPConfig {
  /** The HTTP methods a handler may retry without declaring itself repeatable. */
  readonly retryableMethods?: readonly string[]
}

/**
 * Refuses, at `bootstrap()`, a retry on a controller handler that running twice could harm, whether `@Retry` or the
 * preset `@Resilient` names gives it.
 *
 * A handler may be retried only when every HTTP method routed to it is retryable, by default `SAFE_METHODS` from
 * `@caffeinejs/http`, or when it declares itself repeatable with `@Retry(name, { repeatable: true })` or
 * `@Resilient(name, { repeatable: true })`. `PUT` and `DELETE` are idempotent, not safe: a replay repeats every side
 * effect of the handler, not only its final state. A route that reads its body as a stream is refused even then. A
 * retry on a service a handler calls is not checked.
 */
export class ResilienceHTTPBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience-http'

  #config: Partial<ResilienceHTTPConfig> | undefined
  #retryableMethods: readonly string[] | undefined

  config(config: Partial<ResilienceHTTPConfig>): this {
    this.#config = config
    return this
  }

  /**
   * Replaces the methods a handler may retry without declaring itself repeatable. It replaces the default rather than
   * adding to it: `h.retryableMethods(...SAFE_METHODS, 'PUT')`.
   */
  retryableMethods(...methods: string[]): this {
    this.#retryableMethods = methods
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    kit.container.bind(HTTPTransport, t => t.toSelf().extends(ResilienceTransport))
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (!kit.container.has(ResilienceRegistry)) {
      throw new ErrFeatureNotInstalled(
        'resilience',
        'Install Resilience() from @caffeinejs/resilience/aop next to ResilienceHTTP()',
      )
    }

    const registry = kit.container.get(ResilienceRegistry)
    const methods = this.#retryableMethods ?? this.#config?.retryableMethods ?? [...SAFE_METHODS]
    const retryableMethods = new Set(methods.map(method => method.toUpperCase()))
    for (const { key, binding } of kit.container.getBindingsByLabel(Keys.CONTROLLER)) {
      // The routes are the key's, as the HTTP package builds them; the handlers that run are the bound class's.
      const group = typeof key === 'function' ? getRouteGroup(key)?.toRouteGroup() : undefined
      const cls = (binding.type ?? key) as AnyClass
      if (group === undefined) {
        continue
      }

      for (const route of group.routes) {
        const path = routePath(`${group.prefix ?? ''}${group.path}${route.path}`)
        checkReplay(cls, path, route, stagesOf(cls, route.name, registry), retryableMethods)
      }
    }
  }
}

/**
 * Installs the HTTP replay check for the resilience annotations: a retry on a controller handler for a method that
 * is not safe (`SAFE_METHODS`: `GET`, `HEAD`, `OPTIONS`, `TRACE` and `QUERY`) fails `bootstrap()`, unless the handler
 * declares itself repeatable or the method is allowed with `retryableMethods(...)`.
 *
 * It also keeps the client's own errors, as {@link isClientError} tells them, out of the policies of every controller
 * method: such an error is never retried, a circuit breaker records it as ignored, and a fallback never answers it.
 *
 * It needs `Resilience()`, and `Resilience()` needs it once any controller carries a retry, a circuit breaker or a
 * fallback.
 *
 * @throws {@link ErrInvalidOption} at `bootstrap()` naming the route, the handler and the method.
 */
export function ResilienceHTTP<C = unknown>(configure?: FeatureConfigurer<ResilienceHTTPBuilder<C>, C>): Feature<C> {
  return new ResilienceHTTPBuilder<C>(configure as never)
}
