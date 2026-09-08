import { defineFeature, type Feature, type TypeLambda } from '@caffeinejs/std'

import { MultipartBuilder } from './builder.js'

interface MultipartBuilderF extends TypeLambda {
  readonly Out: MultipartBuilder<this['In']>
}

export interface MultipartFeature extends Feature<MultipartBuilder> {
  readonly _F: MultipartBuilderF
}

/**
 * The `@caffeinejs/multipart` application feature. `.extend(MultipartExt)` registers
 * `@fastify/multipart` so `$multipart.*` pickers can read the request; pass a callback to configure
 * through {@link MultipartBuilder.options}.
 *
 * Import `$multipart` from `@caffeinejs/multipart` at the controller (or any module that builds
 * `@Args([...])`) — the feature does not patch HTTP `$p`.
 */
export const MultipartExt: MultipartFeature = defineFeature({
  name: 'multipart',
  singleton: true,
  install(ctx, configure) {
    const builder = new MultipartBuilder()
    configure?.(builder)
    ctx.addFeature(builder)
  },
}) as MultipartFeature
