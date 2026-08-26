import { $t } from '@caffeinejs/std'
import type {
  ExternalDocumentationObject,
  InfoObject,
  OpenAPIVersion,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './spec/spec.js'
import type { ErrorStatusOptions, InferenceOptions } from './options.js'

/** The default location of the OpenAPI settings in the configuration tree. */
export const OPENAPI_CONFIG_NAMESPACE: readonly string[] = ['openapi']

/**
 * The part of {@link OpenAPIOptions} that can live in a configuration tree.
 *
 * **`routes` is deliberately absent.** The document endpoints are registered as ordinary routes from
 * `[kServiceConfigure]`, which runs before `buildRouting` and therefore before configuration resolves —
 * there is no moment at which a configured path could still reach the router. It stays a code-only setting.
 *
 * Also absent: everything that is a function (`operationId`, `tagFor`, `schemaName`, `transformDocument`),
 * a schema (`errorSchema`), or the security policy the endpoints are compiled against (`secure`), which is
 * needed at the same pre-resolution moment as `routes`.
 */
export interface OpenAPIConfigSlice {
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

/** The keys {@link OpenAPIConfigSlice} declares, used to split the builder's options into the two halves. */
export const OPENAPI_CONFIG_KEYS: readonly (keyof OpenAPIConfigSlice)[] = [
  'version',
  'info',
  'servers',
  'tags',
  'externalDocs',
  'security',
  'securitySchemes',
  'deriveSecuritySchemes',
  'exposeSelf',
  'dedupeComponents',
  'validate',
  'ui',
  'infer',
  'errors',
]

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
  infer: $t.Optional($t.Object({
    validation: $t.Optional($t.Boolean()),
    auth: $t.Optional($t.Boolean()),
  })),
  errors: $t.Optional($t.Object({
    validation: $t.Optional($t.Number()),
    unauthorized: $t.Optional($t.Number()),
    forbidden: $t.Optional($t.Number()),
  })),
})
