import type { ConfigTypeOf, Plugin } from '@caffeinejs/std'
import { ViewBuilder } from './builder.js'
import { ViewOptionsProvider } from './options_provider.js'

/**
 * Builder methods contributed by {@link ViewExt}. Mirrors the fluent `app.view(...)` surface the http
 * builder used to expose directly: a default engine (`.view(configure)`) plus named engines
 * (`.view(name, configure)`).
 */
export interface ViewExt {
  /**
   * The config type is recovered from the builder this was reached through, so `v.config(c => c.app.views)`
   * is typed against the application's own schema. An explicit `Self` type parameter rather than the
   * polymorphic `this` type: `Reconfigured` is `Omit`-based, and a mapped type instantiates `this` — which
   * would freeze the config type to whatever it was before `.config(schema)` re-typed the builder.
   */
  view<Self>(this: Self, configure: (view: ViewBuilder<ConfigTypeOf<Self>>) => void): Self
  view<Self>(this: Self, name: string, configure: (view: ViewBuilder<ConfigTypeOf<Self>>) => void): Self
}

/**
 * The `@caffeinejs/view` application plugin. Pass it to `createWebApplication(..., ViewExt())` to add
 * server-side rendering (`@fastify/view`) without http depending on this package.
 *
 * On the first `.view(...)` call it lazily creates a single {@link ViewOptionsProvider} and registers it as
 * a service; the provider's `configure()` binds itself and the `ViewConfigurer` into the container,
 * which the adapter then discovers via `getManyOptional(FeatureConfigurer)`.
 */
export function ViewExt(): Plugin<ViewExt> {
  let provider: ViewOptionsProvider | undefined

  return {
    name: 'view',
    install(ctx) {
      return {
        view(a: string | ((view: ViewBuilder<never>) => void), b?: (view: ViewBuilder<never>) => void) {
          const name = typeof a === 'string' ? a : undefined
          const configure = (typeof a === 'string' ? b : a)!

          if (provider == null) {
            provider = new ViewOptionsProvider()
            ctx.addService(provider)
          }

          // The config type is a compile-time affair only; the runtime builder is the same object either way.
          configure(provider.builder(name) as ViewBuilder<never>)

          return this
        },
      } as unknown as ViewExt
    },
  }
}
