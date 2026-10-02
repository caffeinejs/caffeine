import type { RouteGroupLabels } from './routing/routing.js'

/** The label a router's binding lives under: the name of the server that serves it. */
export const kBindTo = Symbol('caffeine.http.bindTo')

/** The server `labels` bind a router to, or `undefined` for the application's own. */
export function boundTo(labels: RouteGroupLabels | undefined): string | undefined {
  const name = labels?.get(kBindTo)

  return typeof name === 'string' ? name : undefined
}
