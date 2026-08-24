/**
 * DI key for the configured static mounts ({@link StaticMount}[]) — the directories the adapter serves via
 * `@fastify/static`. Bound by `app.static(s => s.serve(dir, { prefix }))`. When unbound, no static route
 * is registered.
 */
export const kStaticMounts = Symbol.for('@caffeinejs/static:mounts')
