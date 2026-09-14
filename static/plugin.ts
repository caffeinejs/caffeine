import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { StaticBuilder } from './builder.js'

/**
 * The `@caffeinejs/static` application feature. `.with(staticFiles(s => s.serve(root)))` adds static file
 * serving (`@fastify/static`) without http depending on this package.
 */
export function staticFiles<C = unknown>(configure?: FeatureConfigurer<StaticBuilder<C>, C>): Feature<C> {
  return new StaticBuilder<C>(configure as never)
}
