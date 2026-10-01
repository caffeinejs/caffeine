import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { OpenAPIConfig } from '../options.js'
import type {
  ExternalDocumentationObject,
  InfoObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from '../spec/spec.js'

/**
 * A specification object carried through the tree untouched, typed as the specification's own shape.
 *
 * These are OpenAPI's shapes, not ours: numerous, versioned by the specification, and already validated
 * against the document as a whole at boot. A hand-maintained partial mirror here would reject fields that
 * are perfectly legal, and `Value.Clean` strips whatever a schema does not name, so a mirror would silently
 * drop them rather than complain.
 */
const specObject = <T>() => $t.Unsafe<T>($t.Record($t.String(), $t.Unknown()))

/**
 * The schema of the OpenAPI configuration block, satisfying {@link OpenAPIConfig}. Hand the node to
 * `openapi((o, { config }) => o.config(...))`.
 *
 * Nothing is defaulted here: the feature owns its defaults.
 */
export const OpenAPIConfigSchema = $t.Object({
  routes: $t.Optional(
    $t.Object({
      base: $t.Optional($t.String()),
      json: $t.Optional($t.String()),
      // `false` switches the endpoint off.
      yaml: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
      docs: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
    }),
  ),
  version: $t.Optional($t.UnionEnum(['3.1.1', '3.2.0'])),
  info: $t.Optional(specObject<InfoObject>()),
  servers: $t.Optional($t.Array(specObject<ServerObject>())),
  tags: $t.Optional($t.Array(specObject<TagObject>())),
  externalDocs: $t.Optional(specObject<ExternalDocumentationObject>()),
  security: $t.Optional($t.Array(specObject<SecurityRequirementObject>())),
  securitySchemes: $t.Optional($t.Record($t.String(), specObject<SecuritySchemeObject>())),
  deriveSecuritySchemes: $t.Optional($t.Boolean()),
  dedupeComponents: $t.Optional($t.Boolean()),
  validate: $t.Optional($t.Boolean()),
  ui: $t.Optional($t.Record($t.String(), $t.Unknown())),
  infer: $t.Optional(
    $t.Object({
      validation: $t.Optional($t.Boolean()),
      auth: $t.Optional($t.Boolean()),
    }),
  ),
  errors: $t.Optional(
    $t.Object({
      validation: $t.Optional($t.Number()),
      unauthorized: $t.Optional($t.Number()),
      forbidden: $t.Optional($t.Number()),
    }),
  ),
})

type _Satisfies = SchemaSatisfies<OpenAPIConfig, InferConfig<typeof OpenAPIConfigSchema>>
