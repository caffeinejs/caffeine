import type { HTTPSetupContext, RouteBuilder } from '@caffeinejs/http'

/**
 * One part of DevTools: the endpoints it serves under `<path>/<id>`, listed in the index by its id.
 *
 * `routes` runs once, when the plugin installs, with the context every plugin factory gets: resolve what the slice
 * needs there, so a misconfiguration fails at start-up, and read what it reports in the handler, so a request sees
 * the application as it is. The plugin gives every route the same authorization, `cache-control: no-store` and JSON
 * content type; a slice declares none of its own.
 *
 * ```ts
 * const jobs: DevToolsSlice = {
 *   id: 'jobs',
 *   routes: ({ container }) => {
 *     const queue = container.get(JobQueue)
 *     return [new RouteBuilder().method('GET').path('/').handle(() => ({ pending: queue.size }))]
 *   },
 * }
 *
 * devTools(d => d.slices(bindings(), jobs))
 * ```
 */
export interface DevToolsSlice<C = unknown> {
  /** The path segment and the id the index lists: lower-case letters, digits and "-". */
  readonly id: string

  /** The slice's routes, their paths relative to `<path>/<id>`. */
  routes(context: HTTPSetupContext<C>): RouteBuilder[]
}
