import type { Plugin } from '@caffeinejs/std'
import { StaticBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link staticPlugin}. Mirrors the fluent `app.static(...)` surface the http
 * builder used to expose directly.
 */
export interface StaticPluginExt {
  static(configure: (staticFiles: StaticBuilder) => void): this
}

/**
 * The `@caffeinejs/static` application plugin. Pass it to `createWebApplication(..., staticPlugin())` to add
 * static file serving (`@fastify/static`) without http depending on this package.
 *
 * On the first `.static(...)` call it lazily creates a single {@link StaticBuilder} and registers it as a
 * service; the builder's `[kServiceConfigure]` binds the assembled mounts and the `StaticConfigurer` into the
 * container, which the adapter then discovers via `getManyOptional(FeatureConfigurer)`.
 */
export function staticPlugin(): Plugin<StaticPluginExt> {
  let builder: StaticBuilder | undefined

  return {
    name: 'static',
    install(ctx) {
      return {
        static(configure: (staticFiles: StaticBuilder) => void) {
          if (builder == null) {
            builder = new StaticBuilder()
            ctx.addService(builder)
          }

          configure(builder)

          return this
        },
      } as StaticPluginExt
    },
  }
}
