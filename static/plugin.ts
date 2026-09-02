import { defineFeature, type Feature, type ServiceAPI, type TypeLambda } from '@caffeinejs/std'
import { StaticBuilder } from './builder.js'

interface StaticBuilderF extends TypeLambda {
  readonly Out: ServiceAPI<StaticBuilder<this['In']>>
}

export interface StaticFeature extends Feature<ServiceAPI<StaticBuilder>> {
  readonly _F: StaticBuilderF
}

/**
 * The `@caffeinejs/static` application feature. `.extend(StaticExt, s => s.serve(root))` adds static
 * file serving (`@fastify/static`) without http depending on this package.
 */
export const StaticExt: StaticFeature = defineFeature({
  name: 'static',
  singleton: true,
  install(ctx, configure) {
    const builder = new StaticBuilder()
    configure?.(builder)
    ctx.addService(builder)
  },
}) as StaticFeature
