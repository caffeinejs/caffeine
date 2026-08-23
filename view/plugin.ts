import type { Plugin } from '@caffeinejs/std'
import { ViewBuilder } from './builder.js'
import { ViewOptionsProvider } from './options_provider.js'

/**
 * Builder methods contributed by {@link viewPlugin}. Mirrors the fluent `app.view(...)` surface the http
 * builder used to expose directly: a default engine (`.view(configure)`) plus named engines
 * (`.view(name, configure)`).
 */
export interface ViewPluginExt {
  view(configure: (view: ViewBuilder) => void): this
  view(name: string, configure: (view: ViewBuilder) => void): this
}

/**
 * The `@caffeinejs/view` application plugin. Pass it to `createWebApplication(..., viewPlugin())` to add
 * server-side rendering (`@fastify/view`) without http depending on this package.
 *
 * On the first `.view(...)` call it lazily creates a single {@link ViewOptionsProvider} and registers it as
 * a service; the provider's `[kServiceConfigure]` binds itself and the `ViewConfigurer` into the container,
 * which the adapter then discovers via `getManyOptional(FeatureConfigurer)`.
 */
export function viewPlugin(): Plugin<ViewPluginExt> {
  let provider: ViewOptionsProvider | undefined

  return {
    name: 'view',
    install(ctx) {
      return {
        view(a: string | ((view: ViewBuilder) => void), b?: (view: ViewBuilder) => void) {
          const name = typeof a === 'string' ? a : undefined
          const configure = (typeof a === 'string' ? b : a)!

          if (provider == null) {
            provider = new ViewOptionsProvider()
            ctx.addService(provider)
          }

          configure(provider.builder(name))

          return this
        },
      } as ViewPluginExt
    },
  }
}
