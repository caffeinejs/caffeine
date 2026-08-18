import type { Context } from './context.js'

/**
 * Base class for a response value that renders itself. The adapter checks every handler return value (and
 * every resolved Promise) with `instanceof ResponseResult`; a match hands rendering to the value itself via
 * {@link render}, otherwise the value is handed back to Fastify to serialize. This lets response kinds —
 * views, and later SSE and others — plug into the response pipeline without the core adapter knowing their
 * concrete types: they simply extend this class.
 *
 * {@link render} receives the platform-neutral {@link Context} rather than a Fastify reply, so a response
 * kind that only needs the generic response API stays decoupled from Fastify. A Fastify-specific kind may
 * narrow the context to its concrete type (e.g. `FastifyContext`) when it needs platform specifics.
 */
export abstract class ResponseResult {
  /** Renders this result onto the response and returns whatever the adapter should hand back to Fastify. */
  abstract render(ctx: Context): unknown
}
