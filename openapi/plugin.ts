import type { Plugin } from '@caffeinejs/std'
import { OpenAPIBuilder } from './builder.js'

/** The builder method {@link openapiPlugin} contributes. */
export interface OpenAPIPluginExt {
  openapi(configure: (openapi: OpenAPIBuilder) => void): this
}

/**
 * The `@caffeinejs/openapi` application plugin. Pass it to `createWebApplication(..., openapiPlugin())` to
 * generate and serve an OpenAPI document without http depending on this package.
 *
 * On the first `.openapi(...)` call it lazily creates one {@link OpenAPIBuilder} and registers it as a
 * service. The builder's `[kServiceConfigure]` binds the resolved options, registers the document endpoints
 * as ordinary routes, and registers the configurer that generates the document during the server phase.
 */
export function openapiPlugin(): Plugin<OpenAPIPluginExt> {
  let builder: OpenAPIBuilder | undefined

  return {
    name: 'openapi',
    install(ctx) {
      return {
        openapi(configure: (openapi: OpenAPIBuilder) => void) {
          if (builder == null) {
            builder = new OpenAPIBuilder()
            ctx.addService(builder)
          }

          configure(builder)

          return this
        },
      } as OpenAPIPluginExt
    },
  }
}
