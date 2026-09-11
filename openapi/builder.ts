import { registerPlugin, type Route, type RouteGroup } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type AnySchema, type BootstrapKit } from '@caffeinejs/std'
import { configEquals, type ConfigLocation } from '@caffeinejs/std/config'

import { type OpenAPIConfigSlice } from './config.js'
import { OpenAPIDocumentStore } from './document_store.js'
import { registerEndpoints } from './endpoints.js'
import { kOpenAPIOptions } from './keys.js'
import { openapiPlugin } from './openapi_plugin.js'
import {
  type ErrorStatusOptions,
  type InferenceOptions,
  type OpenAPIOptions,
  defaultOpenAPIOptions,
  toRouteAuthz,
} from './options.js'
import { OpenAPISecurityBuilder } from './security_builder.js'
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

/**
 * Configures OpenAPI document generation. Reached through `.extend(openapi(o => ...))`.
 *
 * Most of what ends up in the document is not configured here at all — it is read from the routes the
 * application already declares. This builder covers the document-level facts nothing else can know (title,
 * version, servers), where the document is served, and who may read it.
 */
export class OpenAPIBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'openapi'

  readonly #options: OpenAPIOptions = defaultOpenAPIOptions()
  readonly #store = new OpenAPIDocumentStore()
  #config: ConfigLocation<OpenAPIConfigSlice> | undefined

  /**
   * Reads the document-level facts from a node of the configuration tree, e.g. `c.app.openapi`.
   *
   * Applied **over** what the builder set, so a title written in code is a default a deployment can redirect.
   * Nested blocks merge rather than replace: configuring only `errors.validation` keeps the other two.
   */
  withConfig(config: ConfigLocation<OpenAPIConfigSlice>): this {
    this.#config = config
    return this
  }

  /** The OpenAPI version to emit. Defaults to `3.1.1`; `3.2.0` unlocks the QUERY method and 3.2-only fields. */
  version(version: OpenAPIVersion): this {
    this.#options.version = version
    return this
  }

  /** The document's `info` block. Title and version are required by the specification. */
  info(info: InfoObject): this {
    this.#options.info = info
    return this
  }

  /** Adds a server the API is reachable at. Call it more than once for more than one. */
  server(url: string | ServerObject, description?: string): this {
    this.#options.servers.push(
      typeof url === 'string' ? { url, ...(description === undefined ? {} : { description }) } : url,
    )
    return this
  }

  externalDocs(externalDocs: ExternalDocumentationObject): this {
    this.#options.externalDocs = externalDocs
    return this
  }

  /**
   * Document-level security, applied to any operation that does not state its own. Usually unnecessary:
   * `@Authorize` / `@Roles` / `@AllowAnonymous` already describe each route.
   */
  security(...requirements: SecurityRequirementObject[]): this {
    this.#options.security = requirements
    return this
  }

  /** Declares a tag up front, so its description exists even before a controller uses it. */
  tag(tag: TagObject): this {
    this.#options.tags.push(tag)
    return this
  }

  /**
   * Declares a security scheme explicitly. Merged over the schemes derived from `.authentication(...)`, so it
   * is the way to describe one the framework cannot — notably a bare `addStrategy` handler.
   */
  securityScheme(name: string, scheme: SecuritySchemeObject): this {
    this.#options.securitySchemes[name] = scheme
    return this
  }

  /** Whether to derive `securitySchemes` from the application's registered schemes. On by default. */
  deriveSecuritySchemes(derive = true): this {
    this.#options.deriveSecuritySchemes = derive
    return this
  }

  /** Mounts every document endpoint under a common prefix. */
  base(path: string): this {
    this.#options.routes.base = path
    return this
  }

  /** Where the JSON document is served. */
  json(path: string): this {
    this.#options.routes.json = path
    return this
  }

  /** Where the YAML document is served; `false` disables it. */
  yaml(path: string | false): this {
    this.#options.routes.yaml = path === false ? undefined : path
    return this
  }

  /** Where the documentation UI is served; `false` disables it and drops the Scalar dependency entirely. */
  docs(path: string | false): this {
    this.#options.routes.docs = path === false ? undefined : path
    return this
  }

  /**
   * Configuration passed straight through to the documentation UI, merged over what the page already sets.
   *
   * Untyped on purpose. These are Scalar's own options — a large surface that changes between releases — and
   * a hand-written mirror of them here would reject valid configuration as often as it caught a typo. Consult
   * Scalar's documentation for the keys; this package only forwards them.
   *
   * The page sets `proxyUrl: ''` before merging, so requests go straight from the browser. Overriding that
   * relays every "Try it" request — its URL, headers and credentials — through whichever host is named.
   */
  ui(configuration: Record<string, unknown>): this {
    this.#options.ui = { ...this.#options.ui, ...configuration }
    return this
  }

  /**
   * Requires callers of the document endpoints to authenticate, and optionally to hold roles or satisfy
   * policies. The endpoints are ordinary routes, so this is enforced by the same pipeline as `@Authorize`.
   */
  secure(configure: ((security: OpenAPISecurityBuilder) => void) | string): this {
    const builder = new OpenAPISecurityBuilder()

    if (typeof configure === 'string') {
      builder.schemes(configure)
    } else {
      configure(builder)
    }

    this.#options.secure = builder.build()
    this.#options.secureExplicit = true

    return this
  }

  /**
   * States that the document is deliberately public. Functionally the default, but it silences the startup
   * warning an application gets for serving its API's shape unauthenticated while authentication is on.
   */
  public(): this {
    this.#options.secure = undefined
    this.#options.secureExplicit = true
    return this
  }

  /** Which responses to add that no schema declared. Both are on by default. */
  infer(infer: Partial<InferenceOptions>): this {
    Object.assign(this.#options.infer, infer)
    return this
  }

  /** The status codes used for inferred responses — set `validation` to match your error handler. */
  errors(errors: Partial<ErrorStatusOptions>): this {
    Object.assign(this.#options.errors, errors)
    return this
  }

  /** The body schema of an inferred error response. */
  errorSchema(schema: AnySchema): this {
    this.#options.errorSchema = schema
    return this
  }

  /** Whether the document describes the routes that serve the document. Off by default. */
  exposeSelf(expose = true): this {
    this.#options.exposeSelf = expose
    return this
  }

  /** Names repeated anonymous object schemas into `components.schemas`. Off by default; names are generated. */
  dedupeComponents(dedupe = true): this {
    this.#options.dedupeComponents = dedupe
    return this
  }

  /** Overrides the derived `operationId`. */
  operationId(fn: (router: RouteGroup<unknown>, route: Route<unknown>) => string): this {
    this.#options.operationId = fn
    return this
  }

  /** Overrides the derived tag for a controller. */
  tagFor(fn: (router: RouteGroup<unknown>) => string): this {
    this.#options.tagFor = fn
    return this
  }

  /**
   * Overrides the component name a schema is hoisted under. Return `undefined` to inline it instead.
   *
   * The default is the last segment of the schema's `$id`, which collides when two schemas end in the same
   * segment — `.../v1/Pet` and `.../v2/Pet` both want `Pet`, and that is a boot failure with no way out
   * otherwise.
   */
  schemaName(fn: (schema: SchemaObject) => string | undefined): this {
    this.#options.schemaName = fn
    return this
  }

  /** Merges raw components into the generated ones — responses, parameters, examples, and the rest. */
  components(components: ComponentsObject): this {
    this.#options.components = { ...this.#options.components, ...components }
    return this
  }

  /**
   * Serves a hand-written document instead of generating one. Nothing is derived from the application's
   * routes; `.transformDocument(...)` still runs.
   */
  document(document: OpenAPIDocument): this {
    this.#options.source = { kind: 'document', document }
    return this
  }

  /**
   * Serves a hand-written document read from a `.json` or `.yaml` file. The path is resolved against the
   * process's working directory unless absolute.
   */
  specification(specification: { path: string }): this {
    this.#options.source = { kind: 'file', path: specification.path }
    return this
  }

  /**
   * The last word on the document: runs on the finished object in every mode.
   *
   * Return a new document to replace it, or mutate the one given and return nothing. This is the seam for
   * anything the generator cannot see — a route a plugin registered straight onto the server, an
   * environment-specific server list, internal paths that should not ship.
   */
  transformDocument(fn: (document: OpenAPIDocument) => OpenAPIDocument | void): this {
    this.#options.transformDocument = fn
    return this
  }

  /**
   * Whether to run the boot-time validation. Defaults to on for a generated document and off for an imported
   * one, which may legitimately use constructs the validator rejects.
   */
  validate(validate = true): this {
    this.#options.validate = validate
    return this
  }

  protected bootstrap(kit: BootstrapKit<C>): void {
    const options = this.#resolve()

    // The store, not the document: bindings must all be registered before `container.init()`, which runs
    // long before the server phase that generates the document. Resolving the store and reading
    // `.document` off it is the supported way to reach the document without an HTTP request.
    kit.container.bind(OpenAPIDocumentStore, t => t.toValue(this.#store).internal())

    // Registers the document endpoints as ordinary routes. Still here, before `buildRouting` runs — but
    // now fed the *resolved* options, because configuration resolved before this step.
    const paths = registerEndpoints(kit.container, this.#store, options, toRouteAuthz(options.secure))

    registerPlugin(kit, openapiPlugin(this.#store, options, paths))

    kit.container.bind(kOpenAPIOptions, t => t.toValue(options).internal())
  }

  /**
   * The builder's options with the configured ones folded in.
   *
   * A fluent method is the last word, as everywhere else: a key the builder actually set keeps its value, and
   * configuration fills in the rest. "Actually set" is measured against {@link defaultOpenAPIOptions}, because
   * `#options` starts from the defaults so the setters can write into `routes` and `infer` without guarding
   * every one — a key still holding its default was never named in code.
   *
   * Copied, not referenced. The validated tree is deep-frozen and read through live accessors, and the
   * document these values become is handed to `transformDocument` to edit in place — a frozen `info` would
   * make that throw.
   */
  #resolve(): OpenAPIOptions {
    const configured = this.#config === undefined ? {} : plainCopy(this.#config)

    const folded = foldConfigured(
      this.#options as unknown as Record<string, unknown>,
      configured as Record<string, unknown>,
      defaultOpenAPIOptions() as unknown as Record<string, unknown>,
    ) as unknown as OpenAPIOptions

    // `false` on an endpoint means "do not serve it", which the rest of the package spells `undefined`.
    return { ...folded, routes: withoutDisabled(folded.routes) }
  }
}

/** Turns a `false` endpoint — the configuration spelling of "off" — into the absence the endpoints expect. */
function withoutDisabled(routes: OpenAPIOptions['routes']): OpenAPIOptions['routes'] {
  const off = (value: string | false | undefined): string | undefined => (value === false ? undefined : value)

  return { ...routes, yaml: off(routes.yaml), docs: off(routes.docs) }
}

/**
 * Folds `configured` into `code`, key by key, letting whatever the builder actually set win.
 *
 * `defaults` is what "actually set" is measured against. Nested blocks recurse rather than replace, so an
 * application configuring only `errors.validation` keeps the defaults for the other two.
 */
function foldConfigured(
  code: Record<string, unknown>,
  configured: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...code }

  for (const [key, value] of Object.entries(configured)) {
    if (value === undefined) {
      continue
    }

    const inCode = code[key]
    const fallback = defaults[key]

    if (isPlainRecord(inCode) && isPlainRecord(value)) {
      out[key] = foldConfigured(inCode, value, isPlainRecord(fallback) ? fallback : {})
      continue
    }

    // Named in code, so it stands. Otherwise the configured value fills it in.
    if (configEquals(inCode, fallback)) {
      out[key] = value
    }
  }

  return out
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A plain, mutable deep copy of a configuration node.
 *
 * `structuredClone` cannot do this: a node is a proxy over the frozen tree, and cloning one throws. Reading it
 * key by key goes through the accessors and produces ordinary data the document generator can edit.
 */
function plainCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(element => plainCopy(element)) as T
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = plainCopy((value as Record<string, unknown>)[key])
  }

  return out as T
}
