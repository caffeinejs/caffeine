import { $t } from '@caffeinejs/std'

import type { ErrorStatusOptions, InferenceOptions } from './options.js'
import type {
  ExternalDocumentationObject,
  InfoObject,
  OpenAPIVersion,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './spec/spec.js'

/**
 * The part of {@link OpenAPIOptions} that can live in a configuration tree.
 *
 * Absent: everything that is a function (`operationId`, `tagFor`, `schemaName`, `transformDocument`), a schema
 * (`errorSchema`), and the security policy the endpoints are compiled against (`secure`) — an `AuthzPolicy` is
 * a composition of requirement objects and predicates, so there is nothing a tree could carry.
 */
export interface OpenAPIConfigSlice {
  /**
   * Where the document endpoints are served. `yaml` and `docs` accept `false` to switch one off, which is what
   * `OPENAPI__ROUTES__YAML=false` resolves to.
   *
   * Configurable because the endpoints are registered while the feature configures, which now happens after the
   * configuration has resolved. Each key merges over the code-set routes rather than replacing the block, so
   * setting only `docs` leaves `base` and `json` alone.
   */
  routes?: {
    base?: string
    json?: string
    yaml?: string | false
    docs?: string | false
  }
  version?: OpenAPIVersion
  info?: InfoObject
  servers?: ServerObject[]
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
  security?: SecurityRequirementObject[]
  securitySchemes?: Record<string, SecuritySchemeObject>
  deriveSecuritySchemes?: boolean
  exposeSelf?: boolean
  dedupeComponents?: boolean
  validate?: boolean
  ui?: Record<string, unknown>
  infer?: Partial<InferenceOptions>
  errors?: Partial<ErrorStatusOptions>
}

/**
 * A spec object carried through the tree untouched.
 *
 * These are OpenAPI's shapes, not ours: numerous, versioned by the specification, and already validated
 * against the document as a whole at boot. A hand-maintained partial mirror here would reject fields that
 * are perfectly legal — and `Value.Clean` strips whatever a schema does not name, so a mirror would silently
 * drop them rather than complain.
 */
const specObject = (): ReturnType<typeof $t.Record> => $t.Record($t.String(), $t.Unknown())

/** The schema governing the OpenAPI slice. Nothing is defaulted — `defaultOpenAPIOptions` already is. */
export const openapiConfigSchema = $t.Object({
  routes: $t.Optional(
    $t.Object({
      base: $t.Optional($t.String()),
      json: $t.Optional($t.String()),
      // `false` switches the endpoint off, and is what an env var spelled `=false` coerces to.
      yaml: $t.Optional($t.Union([$t.String(), $t.Boolean()])),
      docs: $t.Optional($t.Union([$t.String(), $t.Boolean()])),
    }),
  ),
  version: $t.Optional($t.String()),
  info: $t.Optional(specObject()),
  servers: $t.Optional($t.Array(specObject())),
  tags: $t.Optional($t.Array(specObject())),
  externalDocs: $t.Optional(specObject()),
  security: $t.Optional($t.Array(specObject())),
  securitySchemes: $t.Optional(specObject()),
  deriveSecuritySchemes: $t.Optional($t.Boolean()),
  exposeSelf: $t.Optional($t.Boolean()),
  dedupeComponents: $t.Optional($t.Boolean()),
  validate: $t.Optional($t.Boolean()),
  ui: $t.Optional(specObject()),
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
