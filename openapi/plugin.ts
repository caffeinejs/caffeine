import { defineFeature, kFeatureSetup, type Feature, type TypeLambda } from '@caffeinejs/std'

import { OpenAPIBuilder } from './builder.js'

interface OpenAPIBuilderF extends TypeLambda {
  readonly Out: OpenAPIBuilder<this['In']>
}

export interface OpenAPIFeature extends Feature<OpenAPIBuilder> {
  readonly _F: OpenAPIBuilderF
}

/**
 * The `@caffeinejs/openapi` application feature. `.extend(OpenAPIExt, o => …)` generates and serves an
 * OpenAPI document without http depending on this package.
 */
export const OpenAPIExt: OpenAPIFeature = defineFeature({
  name: 'openapi',
  singleton: true,
  install(ctx, configure) {
    const builder = new OpenAPIBuilder()
    configure?.(builder)
    ctx.addFeature(builder[kFeatureSetup]())
  },
}) as OpenAPIFeature
