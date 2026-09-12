import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { OpenAPIBuilder } from './builder.js'

/**
 * The `@caffeinejs/openapi` application feature. `.extend(openapi(o => …))` generates and serves an OpenAPI
 * document without http depending on this package.
 */
export function openapi<C = unknown>(configure?: FeatureConfigurer<OpenAPIBuilder<C>, C>): Feature<C> {
  return new OpenAPIBuilder<C>(configure as never)
}
