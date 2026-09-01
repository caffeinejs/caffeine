import { type ServiceBeforeBootstrapIn, type Service, type ServiceAPI, AnySchema, ServiceBootstrapIn } from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigAccessors, type ConfigHandle, type ConfigSlice } from '@caffeinejs/std/config'
import type { Route, RouteGroup } from '@caffeinejs/http'
import {
  OPENAPI_CONFIG_KEYS,
  OPENAPI_CONFIG_NAMESPACE,
  openapiConfigSchema,
  type OpenAPIConfigSlice,
} from './config.js'
import { OpenAPIExtension } from './extension.js'
import { OpenAPIDocumentStore } from './document_store.js'
import { registerEndpoints } from './endpoints.js'

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
 * Configures OpenAPI document generation. Reached through `app.openapi(o => ...)`.
 *
 * Most of what ends up in the document is not configured here at all — it is read from the routes the
 * application already declares. This builder covers the document-level facts nothing else can know (title,
 * version, servers), where the document is served, and who may read it.
 */
export class OpenAPIBuilder<C = unknown> implements Service {
  readonly #options: OpenAPIOptions = defaultOpenAPIOptions()
  readonly #store = new OpenAPIDocumentStore()
  #selector?: (c: ConfigHandle<C>) => ConfigAccessors<OpenAPIConfigSlice>
  #resolved?: ConfigSlice<OpenAPIOptions>

  get name(): string {
    return 'openapi'
  }

  /**
   * Places the OpenAPI settings elsewhere in the configuration tree, e.g. `o.config(c => c.app.docs)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigAccessors<OpenAPIConfigSlice>): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  /** The OpenAPI version to emit. Defaults to `3.1.1`; `3.2.0` unlocks the QUERY method and 3.2-only fields. */
  version(version: OpenAPIVersion): ServiceAPI<this> {
    this.#options.version = version
    return this
  }

  /** The document's `info` block. Title and version are required by the specification. */
  info(info: InfoObject): ServiceAPI<this> {
    this.#options.info = info
    return this
  }

  /** Adds a server the API is reachable at. Call it more than once for more than one. */
  server(url: string | ServerObject, description?: string): ServiceAPI<this> {
    this.#options.servers.push(
      typeof url === 'string'
        ? { url, ...(description === undefined ? {} : { description }) }
        : url,
    )
    return this
  }

  externalDocs(externalDocs: ExternalDocumentationObject): ServiceAPI<this> {
    this.#options.externalDocs = externalDocs
    return this
  }

  /**
   * Document-level security, applied to any operation that does not state its own. Usually unnecessary:
   * `@Authorize` / `@Roles` / `@AllowAnonymous` already describe each route.
   */
  security(...requirements: SecurityRequirementObject[]): ServiceAPI<this> {
    this.#options.security = requirements
    return this
  }

  /** Declares a tag up front, so its description exists even before a controller uses it. */
  tag(tag: TagObject): ServiceAPI<this> {
    this.#options.tags.push(tag)
    return this
  }

  /**
   * Declares a security scheme explicitly. Merged over the schemes derived from `.authentication(...)`, so it
   * is the way to describe one the framework cannot — notably a bare `addStrategy` handler.
   */
  securityScheme(name: string, scheme: SecuritySchemeObject): ServiceAPI<this> {
    this.#options.securitySchemes[name] = scheme
    return this
  }

  /** Whether to derive `securitySchemes` from the application's registered schemes. On by default. */
  deriveSecuritySchemes(derive = true): ServiceAPI<this> {
    this.#options.deriveSecuritySchemes = derive
    return this
  }

  /** Mounts every document endpoint under a common prefix. */
  base(path: string): ServiceAPI<this> {
    this.#options.routes.base = path
    return this
  }

  /** Where the JSON document is served. */
  json(path: string): ServiceAPI<this> {
    this.#options.routes.json = path
    return this
  }

  /** Where the YAML document is served; `false` disables it. */
  yaml(path: string | false): ServiceAPI<this> {
    this.#options.routes.yaml = path === false ? undefined : path
    return this
  }

  /** Where the documentation UI is served; `false` disables it and drops the Scalar dependency entirely. */
  docs(path: string | false): ServiceAPI<this> {
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
  ui(configuration: Record<string, unknown>): ServiceAPI<this> {
    this.#options.ui = { ...this.#options.ui, ...configuration }
    return this
  }

  /**
   * Requires callers of the document endpoints to authenticate, and optionally to hold roles or satisfy
   * policies. The endpoints are ordinary routes, so this is enforced by the same pipeline as `@Authorize`.
   */
  secure(configure: ((security: OpenAPISecurityBuilder) => void) | string): ServiceAPI<this> {
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
  public(): ServiceAPI<this> {
    this.#options.secure = undefined
    this.#options.secureExplicit = true
    return this
  }

  /** Which responses to add that no schema declared. Both are on by default. */
  infer(infer: Partial<InferenceOptions>): ServiceAPI<this> {
    Object.assign(this.#options.infer, infer)
    return this
  }

  /** The status codes used for inferred responses — set `validation` to match your error handler. */
  errors(errors: Partial<ErrorStatusOptions>): ServiceAPI<this> {
    Object.assign(this.#options.errors, errors)
    return this
  }

  /** The body schema of an inferred error response. */
  errorSchema(schema: AnySchema): ServiceAPI<this> {
    this.#options.errorSchema = schema
    return this
  }

  /** Whether the document describes the routes that serve the document. Off by default. */
  exposeSelf(expose = true): ServiceAPI<this> {
    this.#options.exposeSelf = expose
    return this
  }

  /** Names repeated anonymous object schemas into `components.schemas`. Off by default; names are generated. */
  dedupeComponents(dedupe = true): ServiceAPI<this> {
    this.#options.dedupeComponents = dedupe
    return this
  }

  /** Overrides the derived `operationId`. */
  operationId(fn: (router: RouteGroup<unknown>, route: Route<unknown>) => string): ServiceAPI<this> {
    this.#options.operationId = fn
    return this
  }

  /** Overrides the derived tag for a controller. */
  tagFor(fn: (router: RouteGroup<unknown>) => string): ServiceAPI<this> {
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
  schemaName(fn: (schema: SchemaObject) => string | undefined): ServiceAPI<this> {
    this.#options.schemaName = fn
    return this
  }

  /** Merges raw components into the generated ones — responses, parameters, examples, and the rest. */
  components(components: ComponentsObject): ServiceAPI<this> {
    this.#options.components = { ...this.#options.components, ...components }
    return this
  }

  /**
   * Serves a hand-written document instead of generating one. Nothing is derived from the application's
   * routes; `.transformDocument(...)` still runs.
   */
  document(document: OpenAPIDocument): ServiceAPI<this> {
    this.#options.source = { kind: 'document', document }
    return this
  }

  /**
   * Serves a hand-written document read from a `.json` or `.yaml` file. The path is resolved against the
   * process's working directory unless absolute.
   */
  specification(specification: { path: string }): ServiceAPI<this> {
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
  transformDocument(fn: (document: OpenAPIDocument) => OpenAPIDocument | void): ServiceAPI<this> {
    this.#options.transformDocument = fn
    return this
  }

  /**
   * Whether to run the boot-time validation. Defaults to on for a generated document and off for an imported
   * one, which may legitimately use constructs the validator rejects.
   */
  validate(validate = true): ServiceAPI<this> {
    this.#options.validate = validate
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    const code = this.#options

    const slice = defineFeatureConfig<OpenAPIConfigSlice>(kit.config, {
      namespace: OPENAPI_CONFIG_NAMESPACE,
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: openapiConfigSchema,
      values: Object.fromEntries(
        OPENAPI_CONFIG_KEYS
          .filter(key => code[key as keyof OpenAPIOptions] !== undefined)
          .map(key => [key, code[key as keyof OpenAPIOptions]]),
      ),
    })

    this.#resolved = slice.derive(published => {
      // Cloned, not referenced. The validated tree is deep-frozen, and the document these values become is
      // handed to `transformDocument` to edit in place — a frozen `info` would make that throw. Cloning here
      // keeps the tree immutable while giving the generator an object it owns.
      const configured = structuredClone(published) as OpenAPIConfigSlice

      return {
        ...code,
        ...configured,
        // Nested objects merge rather than replace: an application that configures only `errors.validation`
        // must not lose the defaults for the other two.
        infer: { ...code.infer, ...configured.infer },
        errors: { ...code.errors, ...configured.errors },
        routes: mergeRoutes(code.routes, configured.routes),
      } as OpenAPIOptions
    })
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    const resolved = this.#resolved!
    const options = resolved.config

    // The store, not the document: bindings must all be registered before `container.init()`, which runs long
    // before the server phase that generates the document. Resolving the store and reading `.document` off it
    // is the supported way to reach the document without an HTTP request.
    kit.container.bind(OpenAPIDocumentStore).toValue(this.#store).internal()

    // Registers the document endpoints as ordinary routes. Still here, before `buildRouting` runs — but now
    // fed the *resolved* options, because configuration resolved before this step.
    const paths = registerEndpoints(kit.container, this.#store, options, toRouteAuthz(options.secure))

    kit.container.bind(OpenAPIExtension)
      // Reads through the slice, so the generated document reflects the merged configuration. The extension
      // runs at server setup, which is after `container.init()`.
      .toValue(new OpenAPIExtension(this.#store, options, paths))
      .extends()

    return Promise.resolve()
  }
}

/**
 * Folds the configured routes over the code-set ones, key by key.
 *
 * Per key rather than wholesale, so `OPENAPI__ROUTES__DOCS=/reference` moves the documentation page without
 * also erasing where the JSON document is served. `false` is how a configuration switches an endpoint off,
 * matching `.yaml(false)` / `.docs(false)` — and it is what an env var spelled `=false` coerces to.
 */
function mergeRoutes(
  code: OpenAPIOptions['routes'],
  configured: OpenAPIConfigSlice['routes'],
): OpenAPIOptions['routes'] {
  if (configured === undefined) {
    return code
  }

  const optional = (value: string | false | undefined, fallback: string | undefined): string | undefined => {
    if (value === undefined) {
      return fallback
    }
    return value === false ? undefined : value
  }

  return {
    base: configured.base ?? code.base,
    json: configured.json ?? code.json,
    yaml: optional(configured.yaml, code.yaml),
    docs: optional(configured.docs, code.docs),
  }
}
