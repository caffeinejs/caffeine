import { $t } from '@caffeinejs/std'

/** The multipart plugin's settings in an application schema. */
export interface MultipartConfig {
  /** The `@fastify/multipart` options bag: `limits`, `attachFieldsToBody`, … */
  options: Record<string, unknown>
}

/**
 * The schema governing the multipart slice.
 *
 * The bag has to be a `Record` rather than a declared object: the validator strips every property a schema
 * does not name, so a partial mirror of `@fastify/multipart`'s options would silently drop the rest. A
 * `Record` of unknowns is validated as "an object" and handed on with every key intact.
 *
 * Import it into an application schema — `$t.Object({ app: $t.Object({ uploads: multipartConfigSchema }) })` —
 * rather than restating it, then read that node in the plugin factory:
 * `.plugin(c => multipartPlugin(c.app.uploads.options))`.
 */
export const multipartConfigSchema = $t.Object({
  options: $t.Record($t.String(), $t.Unknown(), { default: {} }),
})
