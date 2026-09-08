import { defineFeature, type Feature, type TypeLambda } from '@caffeinejs/std'

import { CorsBuilder } from './builder.js'

interface CorsBuilderF extends TypeLambda {
  readonly Out: CorsBuilder<this['In']>
}

export interface CORSFeature extends Feature<CorsBuilder> {
  readonly _F: CorsBuilderF
}

/**
 * The `@caffeinejs/cors` application feature. `.extend(CORSExt)` registers `@fastify/cors` with
 * Fastify defaults; pass a callback to configure through {@link CorsBuilder.options}. Per-route
 * overrides use the `cors()` extension or the `@CORS` decorator.
 */
export const CORSExt: CORSFeature = defineFeature({
  name: 'cors',
  singleton: true,
  install(ctx, configure) {
    const builder = new CorsBuilder()
    configure?.(builder)
    ctx.addFeature(builder)
  },
}) as CORSFeature
