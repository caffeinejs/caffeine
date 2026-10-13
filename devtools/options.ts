/** What `devTools(d => d.config(...))` reads from a node of the configuration tree. */
export interface DevToolsConfig {
  /**
   * Where the index answers, each slice under it at `<path>/<id>`. Defaults to `/devtools`; `/` serves the index at
   * the server's root.
   */
  path: string
}
