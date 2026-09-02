import { defineFeature, type Feature, type ServiceAPI } from '@caffeinejs/std'
import { HTMLBuilder } from './builder.js'

/**
 * The `@caffeinejs/html` application feature. `.extend(HTMLExt)` publishes application-wide
 * `HTML(...)` response defaults; pass a callback to change them through {@link HTMLBuilder.autoDoctype}.
 * Installing it is optional: `HTML(...)` renders without it.
 */
export const HTMLExt: Feature<ServiceAPI<HTMLBuilder>> = defineFeature({
  name: 'html',
  singleton: true,
  install(ctx, configure) {
    const builder = new HTMLBuilder()
    configure?.(builder)
    ctx.addService(builder)
  },
})
