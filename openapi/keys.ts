import { featureConfigKey } from '@caffeinejs/std/config'

import type { OpenAPIOptions } from './options.js'

/**
 * RouteGroup-level marker on the package's own document endpoints. The generator skips a router carrying it, so
 * the document does not describe the routes that serve the document. `.exposeSelf()` clears it.
 */
export const kOpenAPISelf = Symbol.for('@caffeinejs/openapi:self')

/**
 * Where the resolved OpenAPI options are published: the builder's values folded with the configuration tree.
 *
 * Read with `container.get(Configuration).config(kOpenAPIConfig)`. `undefined` when the feature is not
 * installed.
 */
export const kOpenAPIConfig = featureConfigKey<OpenAPIOptions>('openapi')
