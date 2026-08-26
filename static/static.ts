import type { FastifyStaticOptions } from '@fastify/static'

/**
 * A single static mount — a full `@fastify/static` options object (`root` required, plus `prefix`, `index`,
 * `wildcard`, `maxAge`, etc.). The {@link StaticBuilder} assembles one per `.serve(...)` call and the
 * {@link StaticExtension} registers each.
 */
export type StaticMount = FastifyStaticOptions
