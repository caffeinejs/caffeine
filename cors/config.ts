import { $t } from '@caffeinejs/std'

/** The CORS plugin's settings in an application schema. */
export interface CORSConfig {
  /** The `@fastify/cors` options bag: `origin`, `methods`, `credentials`, … */
  options: Record<string, unknown>
}

/**
 * The schema governing the CORS slice.
 *
 * The bag has to be a `Record` rather than a declared object: the validator strips every property a schema
 * does not name, so a partial mirror of `@fastify/cors`'s options would silently drop the rest. A `Record` of
 * unknowns is validated as "an object" and handed on with every key intact.
 *
 * Import it into an application schema — `$t.Object({ app: $t.Object({ cors: corsConfigSchema }) })` —
 * rather than restating it, then read that node in the plugin factory: `.extend(c => corsPlugin(c.app.cors.options))`.
 */
export const corsConfigSchema = $t.Object({
  options: $t.Record($t.String(), $t.Unknown(), { default: {} }),
})
