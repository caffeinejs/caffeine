import type {
  ExternalDocumentationObject,
  Extensions,
  MediaTypeObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  SecurityRequirementObject,
  ServerObject,
} from '../spec/spec.js'

/**
 * What `@Operation` adds to a route.
 *
 * Every field here is something routing and JSON Schema genuinely cannot express. Nothing that `@Schema`,
 * `@Status`, `@Produces`, `@Authorize` or the `$p` pickers already state belongs in this type — the generator
 * reads those directly, and duplicating them here would recreate the hand-maintained annotation layer this
 * package exists to avoid.
 */
export interface OperationDetail extends Extensions {
  /** A short label for the operation. Consumers show it in lists. */
  summary?: string
  /** The long-form explanation. CommonMark. */
  description?: string
  /**
   * The operation's stable identifier, which client generators turn into a method name. Defaults to
   * `${controller}_${handler}`; set it when the name is part of your published contract.
   */
  operationId?: string
  /** Overrides the tag derived from `@APIGroup` or the controller name. */
  tags?: string[]
  deprecated?: boolean
  /** Omits the operation from the document entirely. */
  hidden?: boolean
  externalDocs?: ExternalDocumentationObject
  /** Servers this one operation lives on, when they differ from the document's. */
  servers?: ServerObject[]
  /** Replaces the security requirement derived from `@Authorize` / `@Roles` / `@AllowAnonymous`. */
  security?: SecurityRequirementObject[]
  /** Merged over the derived parameters, matched by `(name, in)`. Use it to add a description or an example. */
  parameters?: Array<Partial<ParameterObject> & Pick<ParameterObject, 'name' | 'in'>>
  /** Merged over the derived request body. */
  requestBody?: Partial<RequestBodyObject>
  /**
   * Merged over the derived responses, per status. A status present here but not in `@Schema` is added to the
   * document, which is how an operation documents a status whose body has no schema.
   */
  responses?: Record<number | string, ResponseDetail>
}

/** A response, as authored on `@Operation`. `description` is optional here and defaulted by the generator. */
export interface ResponseDetail extends Omit<Partial<ResponseObject>, 'content'> {
  content?: Record<string, MediaTypeObject>
}

/**
 * What `@APIGroup` adds to a controller: the tag its routes belong to, plus anything that should apply to
 * every one of them.
 *
 * A tag declared here also produces the document's top-level `tags[]` entry, so the description is written
 * once rather than repeated on each operation.
 */
export interface APIGroupDetail extends Extensions {
  /** The tag name. Defaults to the controller's class name with a trailing `Controller` removed. */
  name?: string
  description?: string
  /** 3.2.0 only: a short label beside the longer description. */
  summary?: string
  externalDocs?: ExternalDocumentationObject
  /** Omits every route of the controller from the document. */
  hidden?: boolean
  /** Marks every route of the controller deprecated. */
  deprecated?: boolean
  /** Applied to every route that does not state its own. */
  security?: SecurityRequirementObject[]
  /** Applied to every route that does not state its own. */
  servers?: ServerObject[]
  /** Merged into every route's responses — the place for the error shapes a whole controller shares. */
  responses?: Record<number | string, ResponseDetail>
}
