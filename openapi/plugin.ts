import type { ConfigTypeOf, Plugin } from '@caffeinejs/std'
import { OpenAPIBuilder } from './builder.js'

/** The builder method {@link openapiPlugin} contributes. */
export interface OpenAPIPluginExt {
  /**
   * The config type is recovered from the builder this was reached through, so `o.config(c => c.app.docs)`
   * is typed against the application's own schema. An explicit `Self` type parameter rather than the
   * polymorphic `this` type: `Reconfigured` is `Omit`-based, and a mapped type instantiates `this`.
   */
  openapi<Self>(this: Self, configure: (openapi: OpenAPIBuilder<ConfigTypeOf<Self>>) => void): Self
}

/**
 * The `@caffeinejs/openapi` application plugin. Pass it to `createWebApplication(..., openapiPlugin())` to
 * generate and serve an OpenAPI document without http depending on this package.
 *
 * On the first `.openapi(...)` call it lazily creates one {@link OpenAPIBuilder} and registers it as a
 * service. The builder's `[kServiceConfigure]` binds the resolved options, registers the document endpoints
 * as ordinary routes, and registers the extension that generates the document at start-up.
 */
export function openapiPlugin(): Plugin<OpenAPIPluginExt> {
  let builder: OpenAPIBuilder | undefined

  return {
    name: 'openapi',
    install(ctx) {
      return {
        openapi(configure: (openapi: OpenAPIBuilder<never>) => void) {
          if (builder == null) {
            builder = new OpenAPIBuilder()
            ctx.addService(builder)
          }

          // The config type is a compile-time affair only; the runtime builder is the same object either way.
          configure(builder as OpenAPIBuilder<never>)

          return this
        },
      } as unknown as OpenAPIPluginExt
    },
  }
}
