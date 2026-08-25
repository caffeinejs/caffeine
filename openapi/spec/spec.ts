/**
 * The OpenAPI document model, covering 3.1.1 and the 3.2.0 additions this package can source.
 *
 * Hand-written rather than taken from a dependency: the shape is a stable published specification, the subset
 * that matters here is small, and owning it keeps the generator's output typed end to end without pinning the
 * package to someone else's release cadence.
 *
 * @see https://spec.openapis.org/oas/v3.1.1
 * @see https://spec.openapis.org/oas/v3.2.0
 */

/** A JSON Schema object. Under OAS 3.1+ this is JSON Schema 2020-12, which is what `$t` already emits. */
export type SchemaObject = Record<string, unknown>

/**
 * A reference to a component, in place of the object itself.
 *
 * Every `components` section may be referenced this way, which is what makes a shared `ErrorResponse` or a
 * reusable `page` parameter worth declaring once.
 */
export interface ReferenceObject {
  $ref: string
  summary?: string
  description?: string
}

/** A component that may appear inline or as a `$ref`. */
export type Referenceable<T> = T | ReferenceObject

/** The OpenAPI versions this package emits. */
export type OpenAPIVersion = '3.1.1' | '3.2.0'

/** Vendor extensions. The specification reserves every `x-` prefixed key for them. */
export type Extensions = Record<`x-${string}`, unknown>

export interface OpenAPIDocument extends Extensions {
  openapi: OpenAPIVersion
  info: InfoObject
  /** 3.2.0 only: the canonical URI of this document. */
  $self?: string
  jsonSchemaDialect?: string
  servers?: ServerObject[]
  paths?: Record<string, PathItemObject>
  webhooks?: Record<string, PathItemObject>
  components?: ComponentsObject
  security?: SecurityRequirementObject[]
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
}

export interface InfoObject extends Extensions {
  title: string
  version: string
  summary?: string
  description?: string
  termsOfService?: string
  contact?: ContactObject
  license?: LicenseObject
}

export interface ContactObject extends Extensions {
  name?: string
  url?: string
  email?: string
}

export interface LicenseObject extends Extensions {
  name: string
  /** An SPDX expression. Mutually exclusive with `url`. */
  identifier?: string
  url?: string
}

export interface ServerObject extends Extensions {
  url: string
  description?: string
  variables?: Record<string, ServerVariableObject>
}

export interface ServerVariableObject extends Extensions {
  default: string
  enum?: string[]
  description?: string
}

export interface TagObject extends Extensions {
  name: string
  summary?: string
  description?: string
  externalDocs?: ExternalDocumentationObject
  /** 3.2.0 only: the parent tag, for hierarchical grouping. */
  parent?: string
  /** 3.2.0 only: how a consumer should treat the grouping (`nav`, `badge`, `audience`, ...). */
  kind?: string
}

export interface ExternalDocumentationObject extends Extensions {
  url: string
  description?: string
}

/** The eight operation fields a 3.1 PathItem allows. Anything else needs 3.2's `additionalOperations`. */
export type HTTPMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'

export interface PathItemObject extends Extensions {
  summary?: string
  description?: string
  servers?: ServerObject[]
  parameters?: ParameterObject[]
  get?: OperationObject
  put?: OperationObject
  post?: OperationObject
  delete?: OperationObject
  options?: OperationObject
  head?: OperationObject
  patch?: OperationObject
  trace?: OperationObject
  /**
   * 3.2.0 only: operations keyed by any other HTTP method, uppercase — `QUERY`, `LOCK`. A 3.1 PathItem has no
   * place for these at all, which is why a `@Query` route is dropped from a 3.1 document.
   */
  additionalOperations?: Record<string, OperationObject>
}

export interface OperationObject extends Extensions {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  externalDocs?: ExternalDocumentationObject
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  // Concrete rather than `Referenceable`: the generator always builds these itself, and widening the type
  // would push a `$ref` check onto every consumer for a shape this package never produces. A shared response
  // still lives in `components.responses`; an operation just inlines what it needs.
  responses?: Record<string, ResponseObject>
  /** Out-of-band requests this operation may make back to the caller, keyed by a runtime expression. */
  callbacks?: Record<string, Referenceable<Record<string, PathItemObject>>>
  deprecated?: boolean
  security?: SecurityRequirementObject[]
  servers?: ServerObject[]
}

/** Where a parameter travels. `path` parameters are always required. */
export type ParameterLocation = 'query' | 'header' | 'path' | 'cookie'

export interface ParameterObject extends Extensions {
  name: string
  in: ParameterLocation
  description?: string
  required?: boolean
  deprecated?: boolean
  allowEmptyValue?: boolean
  style?: string
  explode?: boolean
  schema?: SchemaObject
  example?: unknown
  examples?: Record<string, Referenceable<ExampleObject>>
  content?: Record<string, MediaTypeObject>
}

export interface RequestBodyObject extends Extensions {
  content: Record<string, MediaTypeObject>
  description?: string
  required?: boolean
}

export interface MediaTypeObject extends Extensions {
  schema?: SchemaObject
  example?: unknown
  examples?: Record<string, Referenceable<ExampleObject>>
  encoding?: Record<string, EncodingObject>
  /** 3.2.0 only: the schema of each item in a sequential (streaming) media type. */
  itemSchema?: SchemaObject
}

export interface EncodingObject extends Extensions {
  contentType?: string
  headers?: Record<string, Referenceable<HeaderObject>>
  style?: string
  explode?: boolean
  allowReserved?: boolean
}

export interface ResponseObject extends Extensions {
  description: string
  /** 3.2.0 only: a short label alongside the longer `description`. */
  summary?: string
  headers?: Record<string, Referenceable<HeaderObject>>
  content?: Record<string, MediaTypeObject>
  links?: Record<string, Referenceable<LinkObject>>
}

export type HeaderObject = Omit<ParameterObject, 'name' | 'in'>

export interface LinkObject extends Extensions {
  operationId?: string
  operationRef?: string
  parameters?: Record<string, unknown>
  requestBody?: unknown
  description?: string
  server?: ServerObject
}

export interface ExampleObject extends Extensions {
  summary?: string
  description?: string
  value?: unknown
  externalValue?: string
}

export interface ComponentsObject extends Extensions {
  schemas?: Record<string, SchemaObject>
  responses?: Record<string, Referenceable<ResponseObject>>
  parameters?: Record<string, Referenceable<ParameterObject>>
  examples?: Record<string, Referenceable<ExampleObject>>
  requestBodies?: Record<string, RequestBodyObject>
  headers?: Record<string, Referenceable<HeaderObject>>
  securitySchemes?: Record<string, SecuritySchemeObject>
  links?: Record<string, Referenceable<LinkObject>>
  pathItems?: Record<string, PathItemObject>
}

/**
 * A scheme name mapped to the scopes it requires. An empty object requires nothing of the caller and is how a
 * route opts out of the document-level requirement entirely.
 */
export type SecurityRequirementObject = Record<string, string[]>

export type SecuritySchemeObject
  = | HTTPSecurityScheme
    | APIKeySecurityScheme
    | OpenIDConnectSecurityScheme
    | OAuth2SecurityScheme

export interface HTTPSecurityScheme extends Extensions {
  type: 'http'
  scheme: string
  bearerFormat?: string
  description?: string
}

export interface APIKeySecurityScheme extends Extensions {
  type: 'apiKey'
  name: string
  in: 'query' | 'header' | 'cookie'
  description?: string
}

export interface OpenIDConnectSecurityScheme extends Extensions {
  type: 'openIdConnect'
  openIdConnectUrl: string
  description?: string
}

export interface OAuth2SecurityScheme extends Extensions {
  type: 'oauth2'
  flows: OAuthFlowsObject
  description?: string
}

export interface OAuthFlowsObject extends Extensions {
  implicit?: OAuthFlowObject
  password?: OAuthFlowObject
  clientCredentials?: OAuthFlowObject
  authorizationCode?: OAuthFlowObject
}

export interface OAuthFlowObject extends Extensions {
  /** Required for `implicit` and `authorizationCode`. */
  authorizationUrl?: string
  /** Required for every flow except `implicit`. */
  tokenUrl?: string
  refreshUrl?: string
  scopes: Record<string, string>
}
