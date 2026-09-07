import { defineFeature, type Feature, type ServiceAPI, type TypeLambda } from '@caffeinejs/std'

import { HTMLBuilder } from './builder.js'

interface HTMLBuilderF extends TypeLambda {
  readonly Out: ServiceAPI<HTMLBuilder<this['In']>>
}

export interface HTMLFeature extends Feature<ServiceAPI<HTMLBuilder>> {
  readonly _F: HTMLBuilderF
}

/**
 * The `@caffeinejs/html` application feature. `.extend(HTMLExt)` publishes application-wide
 * `HTML(...)` response defaults; pass a callback to change them through {@link HTMLBuilder.autoDoctype}.
 * Installing it is optional: `HTML(...)` renders without it.
 */
export const HTMLExt: HTMLFeature = defineFeature({
  name: 'html',
  singleton: true,
  install(ctx, configure) {
    const builder = new HTMLBuilder()
    configure?.(builder)
    ctx.addService(builder)
  },
}) as HTMLFeature
