import '@caffeinejs/http'

/**
 * An `HTML(...)` response's settings: what a route or a router sets with `.config({ html: { … } })`, and what
 * `html()` fills in for every route it covers.
 */
export interface HTMLDefaults {
  /** Whether a document starting with `<html>` gains a `<!doctype html>` prefix. */
  autoDoctype: boolean
}

declare module '@caffeinejs/http' {
  interface RouteOptions {
    /**
     * Read by `HTML(...)`. Set on a route or a router with `.config({ html: { autoDoctype: false } })`; `html()`
     * resolves it for every route it covers, the route's own value winning over the plugin's.
     */
    html?: Partial<HTMLDefaults>
  }
}
