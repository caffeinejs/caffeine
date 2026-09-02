import { defineFeature, type Feature, type ServiceAPI } from '@caffeinejs/std'
import { CorsBuilder } from './builder.js'

/**
 * The `@caffeinejs/cors` application feature. `.extend(CORSExt)` registers `@fastify/cors` with
 * Fastify defaults; pass a callback to configure through {@link CorsBuilder.options}. Per-route
 * overrides use the `cors()` extension or the `@CORS` decorator.
 */
export const CORSExt: Feature<ServiceAPI<CorsBuilder>> = defineFeature({
  name: 'cors',
  singleton: true,
  install(ctx, configure) {
    const builder = new CorsBuilder()
    configure?.(builder)
    ctx.addService(builder)
  },
})
