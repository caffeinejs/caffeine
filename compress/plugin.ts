import { feature, type Feature } from '@caffeinejs/std'

import { CompressBuilder } from './builder.js'

/**
 * The `@caffeinejs/compress` application feature. `.extend(CompressExt())` registers `@fastify/compress`
 * with Fastify defaults; pass a callback to configure through {@link CompressBuilder.options}. Per-route
 * overrides use the `compress()` route extension or the `@Compress` decorator.
 */
export const CompressExt = (): Feature<CompressBuilder> => feature('compress', () => new CompressBuilder())
