/**
 * DI key for the resolved {@link OpenAPIOptions}. Bound by the OpenAPI builder, so it is absent in an
 * application that never called `.openapi(...)` — which is how the configurer stays inert by default.
 */
export const kOpenAPIOptions = Symbol.for('@caffeinejs/openapi:options')

/**
 * Router-level marker on the package's own document endpoints. The generator skips a router carrying it, so
 * the document does not describe the routes that serve the document. `.exposeSelf()` clears it.
 */
export const kOpenAPISelf = Symbol.for('@caffeinejs/openapi:self')
