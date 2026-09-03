import { defineFeature, type Feature, type ServiceAPI } from '@caffeinejs/std'

import { CompressBuilder } from './builder.js'

/**
 * The `@caffeinejs/compress` application feature. `.extend(CompressExt)` registers `@fastify/compress`
 * with Fastify defaults; pass a callback to configure through {@link CompressBuilder.options}. Per-route
 * overrides use the `compress()` extension or the `@Compress` decorator.
 */
export const CompressExt: Feature<ServiceAPI<CompressBuilder>> = defineFeature({
  name: 'compress',
  singleton: true,
  install(ctx, configure) {
    const builder = new CompressBuilder()
    configure?.(builder)
    ctx.addService(builder)
  },
})
