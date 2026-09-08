import { defineFeature, type Feature, type TypeLambda } from '@caffeinejs/std'

import { CompressBuilder } from './builder.js'

interface CompressBuilderF extends TypeLambda {
  readonly Out: CompressBuilder<this['In']>
}

export interface CompressFeature extends Feature<CompressBuilder> {
  readonly _F: CompressBuilderF
}

/**
 * The `@caffeinejs/compress` application feature. `.extend(CompressExt)` registers `@fastify/compress`
 * with Fastify defaults; pass a callback to configure through {@link CompressBuilder.options}. Per-route
 * overrides use the `compress()` extension or the `@Compress` decorator.
 */
export const CompressExt: CompressFeature = defineFeature({
  name: 'compress',
  singleton: true,
  install(ctx, configure) {
    const builder = new CompressBuilder()
    configure?.(builder)
    ctx.addFeature(builder)
  },
}) as CompressFeature
