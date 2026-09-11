import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { ViewBuilder } from './builder.js'

/**
 * The `@caffeinejs/view` application feature. `.extend(view(v => v.engine(e => …)))` registers the default
 * engine (`reply.view`); `v.engine('mail', …)` adds a named one.
 */
export function view<C = unknown>(configure?: FeatureConfigurer<ViewBuilder<C>, C>): Feature<C> {
  return new ViewBuilder<C>(configure as never)
}
