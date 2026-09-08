import { $t } from '@caffeinejs/std'

/** The compression feature's slice of the configuration tree. */
export interface CompressConfig {
  /** The `@fastify/compress` options bag: `threshold`, `encodings`, `global`, … */
  options: Record<string, unknown>
}

/**
 * The schema governing the compression slice.
 *
 * The bag has to be a `Record` rather than a declared object: the validator strips every property a schema
 * does not name, so a partial mirror of `@fastify/compress`'s options would silently drop the rest. A `Record`
 * of unknowns is validated as "an object" and handed on with every key intact.
 *
 * Import it into an application schema — `$t.Object({ app: $t.Object({ compress: compressConfigSchema }) })` —
 * rather than restating it, then point the feature at that location with `c.config(x => x.app.compress)`.
 */
export const compressConfigSchema = $t.Object({
  options: $t.Record($t.String(), $t.Unknown(), { default: {} }),
})
