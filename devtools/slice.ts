import type { HTTPSetupContext, Router } from '@caffeinejs/http'

/**
 * One part of DevTools: the endpoints it serves under `<path>/<id>`, listed in the index by its id.
 *
 * `router` runs once, while the plugin's factory runs, with the context every plugin factory gets: resolve what the
 * slice needs there, so a misconfiguration fails at start-up, and read what it reports in the handler, so a request
 * sees the application as it is. The plugin nests the router under `<path>/<id>`, names it `devtools:<id>`, and gives
 * every route the same authorization, `cache-control: no-store` and JSON content type, so a slice declares none of
 * them.
 *
 * ```ts
 * const jobs: DevToolsSlice = {
 *   id: 'jobs',
 *   router: ({ container }) => {
 *     const queue = container.get(JobQueue)
 *     return new Router().get('/', () => ({ pending: queue.size }))
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
  router(context: HTTPSetupContext<C>): Router<any, any, any, any, any>
}
