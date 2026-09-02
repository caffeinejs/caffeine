import type { ConfigTypeOf, Plugin, ServiceAPI } from '@caffeinejs/std'
import { StaticBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link StaticExt}. Mirrors the fluent `app.static(...)` surface the http
 * builder used to expose directly.
 */
export interface StaticExt {
  /**
   * The config type is recovered from the builder this was reached through, so `s.config(c => c.app.assets)`
   * is typed against the application's own schema without the caller naming it again.
   *
   * An explicit `Self` type parameter rather than the polymorphic `this` type: `Reconfigured` is built on
   * `Omit`, and a mapped type instantiates `this` to the type being mapped — which would freeze the config
   * type to whatever the builder was *before* `.config(schema)` re-typed it, i.e. `unknown`.
   */
  static<Self>(this: Self, configure: (staticFiles: ServiceAPI<StaticBuilder<ConfigTypeOf<Self>>>) => void): Self
}

/**
 * The `@caffeinejs/static` application plugin. Pass it to `createWebApplication(..., StaticExt())` to add
 * static file serving (`@fastify/static`) without http depending on this package.
 *
 * On the first `.static(...)` call it lazily creates a single {@link StaticBuilder} and registers it as a
 * service; the builder's `configure()` binds the assembled mounts and the `StaticExtension` into the
 * container, which the adapter then discovers via `getManyOptional(ServerExtension)`.
 */
export function StaticExt(): Plugin<StaticExt> {
  let builder: StaticBuilder | undefined

  return {
    name: 'static',
    install(ctx) {
      return {
        static(configure: (staticFiles: StaticBuilder<never>) => void) {
          if (builder == null) {
            builder = new StaticBuilder()
            ctx.addService(builder)
          }

          // The config type is a compile-time affair only; the runtime builder is the same object either way.
          configure(builder as StaticBuilder<never>)

          return this
        },
      } as unknown as StaticExt
    },
  }
}
