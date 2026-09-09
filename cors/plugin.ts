import { feature, type Feature } from '@caffeinejs/std'

import { CorsBuilder } from './builder.js'

/**
 * The `@caffeinejs/cors` application feature. `.extend(CORSExt())` registers `@fastify/cors` with Fastify
 * defaults; pass a callback to configure through {@link CorsBuilder.options}. Per-route overrides use the
 * `cors()` route extension or the `@CORS` decorator.
 */
export const CORSExt = (): Feature<CorsBuilder> => feature('cors', () => new CorsBuilder())
