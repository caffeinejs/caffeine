/**
 * Fastify route-config marker set on the probe routes. The adapter's server-level `onRequest` hook reads it to
 * skip building a request context for a probe, which no handler down that path ever uses.
 */
export const kHealthRoute = Symbol.for('@caffeinejs/http:health.route')
