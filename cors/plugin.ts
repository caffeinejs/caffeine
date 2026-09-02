import type { Plugin, ServiceAPI } from '@caffeinejs/std'
import { CorsBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link CORSExt}.
 */
export interface CORSExt {
  /**
   * Activates CORS with `@fastify/cors` defaults.
   */
  cors<Self>(this: Self): Self
  /**
   * Activates CORS. Configure Fastify options through {@link CorsBuilder.options}.
   */
  cors<Self>(this: Self, configure: (c: ServiceAPI<CorsBuilder>) => void): Self
}

/**
 * The `@caffeinejs/cors` application plugin. Pass it to
 * `createWebApplication(...).extend(CORSExt())` then call `.cors()` so the adapter registers
 * `@fastify/cors`. Per-route overrides use the `cors()` extension or the `@CORS` decorator.
 *
 * On the first `.cors(...)` call it lazily creates a single {@link CorsBuilder} and registers it as
 * a service; the builder's `bootstrap()` binds the CORS server extension.
 */
export function CORSExt(): Plugin<CORSExt> {
  let builder: CorsBuilder | undefined

  return {
    name: 'cors',
    install(ctx) {
      return {
        cors(configure?: (c: CorsBuilder) => void) {
          if (builder == null) {
            builder = new CorsBuilder()
            ctx.addService(builder)
          }

          configure?.(builder)

          return this
        },
      } as unknown as CORSExt
    },
  }
}
