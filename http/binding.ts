import type { RouteGroupLabels } from './core/routing/routing.js'
import type { RouteGroupSpec } from './core/routing/spec.js'

/** The label a group's server lives under: the name of the listener that serves it. */
export const kBindTo = Symbol('caffeine.http.bindTo')

/** The listener `labels` name, or `undefined` for the application's own server. */
export function boundTo(labels: RouteGroupLabels | undefined): string | undefined {
  const name = labels?.get(kBindTo)

  return typeof name === 'string' ? name : undefined
}

/** A copy of `spec` labelled with the listener `name` that serves it; `spec` itself is not changed. */
export function bindGroup<R>(spec: RouteGroupSpec<R>, name: string): RouteGroupSpec<R> {
  return { ...spec, labels: new Map<symbol, unknown>(spec.labels).set(kBindTo, name) }
}
