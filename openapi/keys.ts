/**
 * RouteGroup-level marker on the package's own document endpoints. The generator skips a router carrying it, so
 * the document does not describe the routes that serve the document. `.exposeSelf()` clears it.
 */
export const kOpenAPISelf = Symbol.for('@caffeinejs/openapi:self')
