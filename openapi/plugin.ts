import { feature, type Feature } from '@caffeinejs/std'

import { OpenAPIBuilder } from './builder.js'

/**
 * The `@caffeinejs/openapi` application feature. `.extend(OpenAPIExt(), o => …)` generates and serves an
 * OpenAPI document without http depending on this package.
 */
export const OpenAPIExt = (): Feature<OpenAPIBuilder> => feature('openapi', () => new OpenAPIBuilder())
