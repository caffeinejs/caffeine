import { token } from '@caffeinejs/di'

import type { OpenAPIOptions } from './options.js'

/**
 * RouteGroup-level marker on the package's own document endpoints. The generator skips a router carrying it, so
 * the document does not describe the routes that serve the document. `.exposeSelf()` clears it.
 */
export const kOpenAPISelf = Symbol.for('@caffeinejs/openapi:self')

/**
 * The resolved OpenAPI options: the builder's values with the configured ones folded over them.
 *
 * Read with `container.getOptional(kOpenAPIOptions)`. Absent when the feature is not installed.
 */
export const kOpenAPIOptions = token<OpenAPIOptions>(Symbol('caffeine.openapi.options'))
