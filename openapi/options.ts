import type { Route, RouteAuthzOptions, RouteGroup } from '@caffeinejs/http'
import type { AnySchema } from '@caffeinejs/std'

import type {
  ComponentsObject,
  ExternalDocumentationObject,
  InfoObject,
  OpenAPIDocument,
  OpenAPIVersion,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './spec/spec.js'

/** Which responses the generator adds that no schema declared. Both are on by default. */
export interface InferenceOptions {
  /**
   * The response produced when request validation rejects the input. Ajv answers it whether or not anyone
   * documented it, so omitting it describes an API that does not exist.
   */
  validation: boolean
  /** The `401` and `403` responses on any route the authorization pipeline protects. */
  auth: boolean
}

/** The status codes the generator uses for the responses it infers. */
export interface ErrorStatusOptions {
  /**
   * Answered when request validation fails. Fastify's default is `400`; an application whose error handler
   * maps body failures elsewhere (the petstore answers `422`) sets it here so the document matches reality.
   */
  validation: number
  /** Answered when authentication is required and absent or rejected. */
  unauthorized: number
  /** Answered when an authenticated caller fails the route's policy. */
  forbidden: number
}

/** How the document endpoints themselves are protected. Compiled into `RouteAuthzOptions`. */
export interface OpenAPISecurityOptions {
  /**
   * Which authentication schemes may satisfy the requirement. Names must match schemes registered through
   * `.authentication(...)`; an unknown one fails at boot.
   */
  schemes?: string[]
  roles?: string[]
  policy?: string | string[]
}

/** The fully resolved OpenAPI configuration the generator and the extension read. */
export interface OpenAPIOptions {
  version: OpenAPIVersion
  info: InfoObject
  servers: ServerObject[]
  externalDocs?: ExternalDocumentationObject
  /** Document-level security, applied to any operation that does not state its own. */
  security?: SecurityRequirementObject[]
  /** Tags declared up front, merged with those derived from `@APIGroup`. */
  tags: TagObject[]
  /** Schemes declared explicitly, merged over any derived from `.authentication(...)`. */
  securitySchemes: Record<string, SecuritySchemeObject>
  /** Whether to derive `securitySchemes` from the application's registered authentication schemes. */
  deriveSecuritySchemes: boolean

  /** Where the document and the UI are served. A path of `undefined` disables that endpoint. */
  routes: {
    base: string
    json: string
    yaml: string | undefined
    docs: string | undefined
  }

  /**
   * Configuration handed to the documentation UI, merged over the defaults the page already sets.
   *
   * Deliberately untyped: the keys are Scalar's, they are numerous, and they move between releases — a
   * hand-maintained mirror of them here would be wrong more often than it was right, and would reject options
   * that work. Nothing in this package reads it; it is passed through verbatim.
   */
  ui: Record<string, unknown> | undefined

  /** Protection for the document endpoints, or `undefined` when they are public. */
  secure: OpenAPISecurityOptions | undefined
  /** Whether the user made an explicit public/secure choice, which decides if the startup warning fires. */
  secureExplicit: boolean

  infer: InferenceOptions
  errors: ErrorStatusOptions
  /** The body of an inferred error response. */
  errorSchema: AnySchema | undefined

  /** Whether the document describes the routes that serve the document. */
  exposeSelf: boolean
  /** Structurally deduplicate repeated anonymous schemas into `components.schemas`. Off by default. */
  dedupeComponents: boolean

  /** Overrides the derived `operationId`. */
  operationId?: (router: RouteGroup<unknown>, route: Route<unknown>) => string
  /** Overrides the derived tag for a controller. */
  tagFor?: (router: RouteGroup<unknown>) => string
  /** Overrides the component name a schema is hoisted under. */
  schemaName?: (schema: SchemaObject) => string | undefined

  /**
   * A hand-written document to serve instead of generating one, or the file to read it from. When present,
   * nothing is derived from the application's routes.
   */
  source: OpenAPISource | undefined
  /**
   * The last word on the document: runs on the finished object in every mode, generated or imported.
   *
   * The escape hatch for everything the generator cannot see. Routes registered straight onto the server by a
   * plugin never reach the router table, so this is where an application adds them; it is equally the place
   * to strip internal paths per environment or merge a hand-written fragment.
   */
  transformDocument?: (document: OpenAPIDocument) => OpenAPIDocument | void
  /**
   * Whether to run the boot-time validation. On for a generated document; off for an imported one, which may
   * legitimately use constructs the validator rejects — `$ref`-based security schemes among them.
   */
  validate: boolean | undefined

  /** Raw components merged into the generated ones, for the parts the generator never produces. */
  components: ComponentsObject | undefined
}

/** Where an imported document comes from. */
export type OpenAPISource = { kind: 'document'; document: OpenAPIDocument } | { kind: 'file'; path: string }

/** Everything the generator needs, with nothing left to default. */
export const DEFAULT_OPENAPI_VERSION: OpenAPIVersion = '3.1.1'

export function defaultOpenAPIOptions(): OpenAPIOptions {
  return {
    version: DEFAULT_OPENAPI_VERSION,
    info: { title: 'API', version: '0.0.0' },
    servers: [],
    tags: [],
    securitySchemes: {},
    deriveSecuritySchemes: true,
    routes: {
      base: '/',
      json: '/openapi.json',
      yaml: '/openapi.yaml',
      docs: '/docs',
    },
    ui: undefined,
    secure: undefined,
    secureExplicit: false,
    infer: { validation: true, auth: true },
    errors: { validation: 400, unauthorized: 401, forbidden: 403 },
    errorSchema: undefined,
    exposeSelf: false,
    dedupeComponents: false,
    source: undefined,
    validate: undefined,
    components: undefined,
  }
}

/**
 * Turns the document-endpoint security options into the `RouteAuthzOptions` the routing layer compiles.
 *
 * The authenticated-user requirement is always present, never merely implied by naming a scheme. `schemes`
 * selects which scheme authenticates and issues the challenge; it states no requirement of its own, so a
 * configuration carrying only `schemes` would otherwise compile to a policy that admits everyone. Emitting an
 * empty options object is what the routing layer reads as "require an authenticated user".
 */
export function toRouteAuthz(secure: OpenAPISecurityOptions | undefined): RouteAuthzOptions | undefined {
  if (secure === undefined) {
    return undefined
  }

  return {
    schemes: secure.schemes,
    roles: secure.roles,
    policy: secure.policy,
  }
}
