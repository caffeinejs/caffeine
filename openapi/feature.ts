import { kFeatureConfigure, kFeatureName, type Feature, type FeatureConfigureKit } from '@caffeinejs/application'

import { OpenAPIProvider } from './provider.js'

class OpenAPIFeature<C> implements Feature<C> {
  get [kFeatureName](): string {
    return 'openapi'
  }

  [kFeatureConfigure](kit: FeatureConfigureKit<C>): void {
    kit.container.bind(OpenAPIProvider, t => t.toValue(new OpenAPIProvider()))
  }
}

/**
 * Binds {@link OpenAPIProvider}, which holds the documents `openapi()` plugins generate. Install it before
 * registering any `.with(openapi(...))`:
 *
 * ```ts
 * createWebApplication()
 *   .install(OpenAPI())
 *   .with(openapi(o => o.info({ title: 'Shop', version: '1.0.0' })))
 * ```
 */
export function OpenAPI<C = unknown>(): Feature<C> {
  return new OpenAPIFeature<C>()
}
