import { FastifyAdapter } from './adapter.js'
import { type AdapterFactory } from './application.js'
import type { FastifyTypes } from './fastify_types.js'

/**
 * The Fastify adapter, which builds its own instance at `ready()` from what `.server(...)` returned. It is what
 * `createWebApplication()` runs on when no adapter is named.
 */
export function fastifyAdapterFactory(): AdapterFactory<FastifyTypes> {
  return kit => new FastifyAdapter(kit)
}
