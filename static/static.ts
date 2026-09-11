import type { FastifyStaticOptions } from '@fastify/static'

import type { SPASettings } from './spa.js'

/**
 * A single static mount — a full `@fastify/static` options object (`root` required, plus `prefix`, `index`,
 * `wildcard`, `maxAge`, etc.). The {@link StaticBuilder} assembles one per `.serve(...)` call and the
 * the plugin registers each.
 */
export type StaticMount = FastifyStaticOptions

/** What the feature actually serves, folded from the configured mounts and the SPA settings. */
export interface ResolvedStatic {
  mounts: StaticMount[]
  spa: SPASettings | undefined
}
