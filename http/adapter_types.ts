/** What `ctx.platform` is at least. `name` says which server library serves the request. */
export interface ContextPlatform {
  readonly name: string
}

/**
 * Every type that belongs to the server library behind an adapter, named once.
 *
 * An adapter declares one of these. The application, its routers and each request's context read their
 * server-specific types off it, so a new one is a new member here rather than a new type parameter everywhere.
 */
export interface AdapterTypes {
  /** The server the adapter drives, which is what the application's `instance` is. */
  instance: unknown

  /** The request routes are compiled against. */
  request: unknown

  /** What `.with(factory)`, `router.plugin(...)` and `@Use(...)` install. `never` when the server takes none. */
  extension: unknown

  /** The request-lifecycle points `app.use(..., { hook })` accepts. `never` when the server has none. */
  hook: string

  /** What `ctx.req.raw` is. */
  raw: unknown

  /** What `ctx.cookie(...)` and `ctx.deleteCookie(...)` take as options. */
  cookieOptions: unknown

  /** Whether `ctx.req.signedCookie(...)` answers with a promise. */
  asyncCookies: boolean

  /** What `ctx.platform` is. */
  platform: ContextPlatform

  /**
   * What `.server(configure)` resolves to: the server's construction and listen settings, in the sections the
   * adapter names. Several calls shallow-merge section by section, in call order.
   */
  serverOptions: object

  /** What `app.run(...)` takes and hands `Adapter.run(...)` untouched. `[]` when the server takes nothing. */
  runArgs: readonly unknown[]
}

/**
 * The adapters loaded in this compilation, by name. An adapter package adds its own entry:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface AdapterRegistry {
 *     mine: MyAdapterTypes
 *   }
 * }
 * ```
 *
 * Code written without knowing its adapter is typed against every entry at once: `@Use(...)` takes any registered
 * extension, and `ctx.platform` on a plain `Context` is any registered platform. With more than one entry, a
 * reader narrows on `ctx.platform.name` first. The Fastify entry is declared by this package's root entry point.
 */
export interface AdapterRegistry {}

/** Any registered adapter's types. */
export type AnyAdapterTypes = AdapterRegistry[keyof AdapterRegistry]

/** What any registered adapter installs. */
export type AnyAdapterExtension = AnyAdapterTypes['extension']
