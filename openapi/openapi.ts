import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import {
  AuthenticationSchemeProvider,
  AuthenticationService,
  HTTPPlugin,
  kAuthSchemeDescriptors,
  kErrorHandlingOptions,
  Router,
  type AdapterExtensionFactory,
  type AuthSchemeDescriptor,
  type HTTPPluginConfigurer,
  type HTTPSetupContext,
  type IRoute,
  type IRouteGroup,
  type RouteAuthzOptions,
} from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'
import { parse as fromYAML, stringify as toYAML } from 'yaml'

import { DEFAULT_DOCUMENT_NAME } from './_default_name.js'
import { ErrOpenAPIConfiguration } from './errors.js'
import { generateDocument, validateDocument } from './generate/generator.js'
import { joinPaths } from './generate/paths.js'
import { defaultOpenAPIOptions, toRouteAuthz, type OpenAPIOptions, type OpenAPISource } from './options.js'
import { kBuild, OpenAPIOptionsBuilder } from './options_builder.js'
import { kPublish, kReserve, OpenAPIProvider } from './provider.js'
import type { OpenAPIDocument } from './spec/spec.js'
import { readScalarBundle, scalarPage } from './ui/scalar.js'

/** Authors {@link OpenAPIOptions} through {@link OpenAPIOptionsBuilder} instead of the plain object. */
export type OpenAPIConfigurer<C = unknown> = HTTPPluginConfigurer<OpenAPIOptionsBuilder, C>

/** The path the Scalar bundle is served from, relative to the documentation page. */
const ASSET_SEGMENT = '/_scalar.js'

/** A year. The bundle is immutable at this URL for the process's lifetime. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** What a document name may hold: it becomes part of the default paths and of a route group's name. */
const DOCUMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

interface EndpointPaths {
  json: string | undefined
  yaml: string | undefined
  docs: string | undefined
  asset: string | undefined
}

/**
 * Generates an OpenAPI document, registers it with `OpenAPIProvider`, and serves it, as a plugin:
 * `.with(openapi(o => ...))`. Needs `.install(OpenAPI())` on the application, and installs on the application or a
 * listener: a router or a controller is refused.
 *
 * Most of what ends up in the document is not configured here at all — it is read from the routes the
 * application already declares. The builder covers the document-level facts nothing else can know (title,
 * version, servers), where the document is served, and who may read it.
 *
 * Without a name the document is `default`. Name each one to register several, on one server or one per listener:
 *
 * ```ts
 * .install(OpenAPI())
 * .with(openapi('public', o => o.include((group, route, path) => !path.startsWith('/admin'))))
 * .with(openapi('admin', o => o.include((group, route, path) => path.startsWith('/admin'))))
 * ```
 *
 * @throws ErrOpenAPIConfiguration when the name is not letters, digits, `-` and `_`, starting with a letter or digit,
 *   and at start-up when it is installed on a router or a controller.
 */
export function openapi<C = unknown>(configure?: OpenAPIConfigurer<C>): AdapterExtensionFactory<HTTPPlugin, C>
export function openapi<C = unknown>(
  name: string,
  configure?: OpenAPIConfigurer<C>,
): AdapterExtensionFactory<HTTPPlugin, C>
export function openapi<C = unknown>(
  nameOrConfigure?: string | OpenAPIConfigurer<C>,
  maybeConfigure?: OpenAPIConfigurer<C>,
): AdapterExtensionFactory<HTTPPlugin, C> {
  const named = typeof nameOrConfigure === 'string'
  const name = named ? nameOrConfigure : DEFAULT_DOCUMENT_NAME
  const configure = named ? maybeConfigure : nameOrConfigure

  assertDocumentName(name)

  return context => {
    // Factories run at start-up: a plugin with nowhere to register its document is a boot failure naming the fix.
    if (!context.hasFeature('openapi')) {
      throw new ErrFeatureNotInstalled('openapi', 'Install it with .install(OpenAPI()) on the application')
    }

    const builder = new OpenAPIOptionsBuilder(name)
    configure?.(builder, context)
    const options = builder[kBuild]()
    assertUIHasDocument(name, options)

    const provider = context.container.get(OpenAPIProvider)
    provider[kReserve](name)

    return new OpenAPIPlugin(name, options, provider)
  }
}

/**
 * Collects the routes of its server as they register and generates the document in `onReady`, once all of them
 * have — whichever order the plugins that contributed them were installed in. The routes that serve the document
 * are real, protectable routes on a router it mounts, marked hidden so the document never describes them.
 *
 * Failures are fatal to start-up. A malformed document is not something a consumer recovers from at request
 * time, and one that silently omits routes is worse than one that never shipped; the framework already
 * refuses to start on an unconvertible route schema, and this matches it.
 */
class OpenAPIPlugin extends HTTPPlugin {
  override readonly name: string
  readonly #document: string
  readonly #options: OpenAPIOptions
  readonly #provider: OpenAPIProvider

  constructor(name: string, options: OpenAPIOptions, provider: OpenAPIProvider) {
    super()
    this.name = name === DEFAULT_DOCUMENT_NAME ? 'openapi' : `openapi:${name}`
    this.#document = name
    this.#options = options
    this.#provider = provider
  }

  register(context: HTTPSetupContext): void {
    const name = this.#document
    const options = this.#options
    const provider = this.#provider
    const server = context.app.server

    if (server === undefined) {
      throw new ErrOpenAPIConfiguration(
        errMessage(`Cannot install openapi() on a router or a controller: the document "${name}" describes a server`)
          .solutions('Register it on the application or a listener: ".with(openapi(...))"')
          .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
          .build(),
      )
    }

    const { container } = context
    const paths = resolvePaths(options)
    const served = paths.json !== undefined || paths.yaml !== undefined || paths.docs !== undefined
    const descriptors = container.getOptional<Map<string, AuthSchemeDescriptor>>(kAuthSchemeDescriptors)
    assertSchemesExist(container, options)
    if (served) {
      warnIfUnprotected(container, name, options)
    }

    // A group holds only the routes that registered, in registration order; the HEAD twin of a GET is not listed.
    const groups = new Map<IRouteGroup<unknown>, Set<IRoute<unknown>>>()
    context.app.hook('onRoute', ({ route, group }) => {
      let routes = groups.get(group as IRouteGroup<unknown>)
      if (routes === undefined) {
        routes = new Set()
        groups.set(group as IRouteGroup<unknown>, routes)
      }

      routes.add(route as IRoute<unknown>)
    })

    // Assigned in `onReady`, which settles before any request reaches the handlers below.
    let document!: OpenAPIDocument
    let yaml!: string

    context.app.hook('onReady', () => {
      const warnings: string[] = []
      const generated =
        options.source === undefined
          ? generateDocument({
              routeGroups: Array.from(groups, ([group, routes]) => ({ ...group, routes: [...routes] })),
              options: withBasePathServer(options, server.basePath),
              schemes: descriptors,
              problemMediaTypes: problemMediaTypes(container),
              onWarning: message => warnings.push(message),
            })
          : readDocument(options.source)

      // The transform runs in both modes, so it is equally the way to patch a generated document and to adjust
      // an imported one. Mutating in place and returning nothing is supported because it is the obvious thing
      // to reach for.
      const transformed = options.transformDocument?.(generated) ?? generated

      // A generated document is validated by default; an imported one is not, because a hand-written spec may
      // legitimately use constructs the validator rejects. `.validate(true)` opts one back in.
      if (options.validate ?? options.source === undefined) {
        validateDocument(transformed)
      }

      for (const warning of warnings) {
        process.emitWarning(
          name === DEFAULT_DOCUMENT_NAME ? warning : `OpenAPI document "${name}": ${warning}`,
          'CaffeineOpenAPIWarning',
        )
      }

      document = publishable(name, transformed)
      yaml = toYAML(document)
      provider[kPublish](name, document)
      // Generated once: the routes it was read from need not stay held for the server's lifetime.
      groups.clear()
    })

    if (!served) {
      return
    }

    const { docsPage, asset } = ui(options, paths, server.basePath)
    const authz = options.secure === undefined ? undefined : toRouteAuthz(options.secure)
    const router = new Router(options.routes.base === '/' ? '' : options.routes.base)
      .name(this.name)
      .detail('openapi', { hidden: true })

    if (paths.json !== undefined) {
      endpoint(router, paths.json, 'application/json', authz).handler(() => document)
    }
    if (paths.yaml !== undefined) {
      endpoint(router, paths.yaml, 'application/yaml', authz).handler(() => yaml)
    }
    if (paths.docs !== undefined) {
      endpoint(router, paths.docs, 'text/html', authz).handler(() => docsPage)
    }
    if (paths.asset !== undefined) {
      endpoint(router, paths.asset, 'text/javascript', authz)
        .header('cache-control', ASSET_CACHE_CONTROL)
        .handler(() => asset)
    }

    context.app.mount(router)
  }
}

// The formats error handling negotiates among, so the document lists what the server can send.
// Error handling is registered in every application, so its options are always bound.
function problemMediaTypes(container: HTTPSetupContext['container']): string[] {
  return [...container.get(kErrorHandlingOptions).formats.values()].map(format => format.mediaType)
}

/**
 * A deep-frozen copy of the document, so freezing it touches none of the objects the application handed the
 * builder, and no consumer of the provider can change what the endpoints serve.
 *
 * Refused here rather than at the first request: a value `structuredClone` cannot copy, and a cycle, which a YAML
 * alias inside its own anchor produces and which neither the JSON endpoint nor a consumer can serialize.
 */
function publishable(name: string, document: OpenAPIDocument): OpenAPIDocument {
  let copy: OpenAPIDocument
  try {
    copy = structuredClone(document)
  } catch (cause) {
    throw new ErrOpenAPIConfiguration(
      errMessage(
        `Cannot publish the OpenAPI document "${name}": it holds a value that is not plain data: ${describe(cause)}`,
      )
        .solutions('Return only objects, arrays, strings, numbers, booleans and null from transformDocument')
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }

  deepFreeze(name, copy, '#', new Set())
  return copy
}

// `ancestors` holds the objects on the path from the root: meeting one again is a cycle. An object already frozen
// was walked in full where it was first met, which a shared, non-cyclic object reached twice relies on.
function deepFreeze(name: string, value: unknown, pointer: string, ancestors: Set<object>): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }

  if (ancestors.has(value)) {
    throw new ErrOpenAPIConfiguration(
      errMessage(`Cannot publish the OpenAPI document "${name}": it refers back to itself at "${pointer}"`)
        .solutions('Replace the repeated object with a $ref to a component, such as "#/components/schemas/Node"')
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }

  ancestors.add(value)
  for (const [key, child] of Object.entries(value)) {
    deepFreeze(name, child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, ancestors)
  }
  ancestors.delete(value)
  Object.freeze(value)
}

function assertDocumentName(name: string): void {
  if (!DOCUMENT_NAME.test(name)) {
    throw new ErrOpenAPIConfiguration(
      errMessage(
        `Cannot register the OpenAPI document "${name}": a name holds only letters, digits, "-" and "_", ` +
          'and starts with a letter or a digit',
      )
        .solutions('Name it like a path segment, such as openapi("admin-api", o => ...)')
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }
}

/** The page loads the JSON document, so a UI without one would render an error in every browser that opens it. */
function assertUIHasDocument(name: string, options: OpenAPIOptions): void {
  if (options.routes.docs !== undefined && options.routes.json === undefined) {
    throw new ErrOpenAPIConfiguration(
      errMessage(`Cannot serve the documentation UI of the OpenAPI document "${name}": its JSON endpoint is off`)
        .solutions(
          `Serve the JSON document with .json("${defaultOpenAPIOptions(name).routes.json}")`,
          'Call .docs(false) to serve no UI',
        )
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }
}

/**
 * Adds one endpoint route to `router`.
 *
 * `authorize` is called only when protection was actually configured. Routing reads *any* defined authz —
 * including an empty object — as protection, and an application with no authentication then refuses to start
 * with "authorization is configured but authentication is not". Passing `{}` to mean "public" would break
 * every unauthenticated application that turns documentation on.
 */
function endpoint(router: Router, path: string, contentType: string, authz: RouteAuthzOptions | undefined) {
  const route = router.get(path).produces(contentType)

  return authz === undefined ? route : route.authorize(authz)
}

/**
 * Resolves the configured paths against the base, and derives the asset path from the docs path so the bundle
 * always sits beside the page that loads it.
 */
function resolvePaths(options: OpenAPIOptions): EndpointPaths {
  const { routes } = options

  return {
    json: routes.json,
    yaml: routes.yaml,
    docs: routes.docs,
    asset: routes.docs === undefined ? undefined : `${routes.docs}${ASSET_SEGMENT}`,
  }
}

/** The URL a browser requests, which includes the router base the routes are mounted under. */
function publicURL(base: string, path: string): string {
  return joinPaths(base === '/' ? '' : base, path)
}

/**
 * The options a generated document is built from, naming the application's base path as its server when the
 * application named none: the paths describe the routes as the application declares them, and the server is where
 * a client finds them.
 */
function withBasePathServer(options: OpenAPIOptions, basePath: string): OpenAPIOptions {
  return basePath === '' || options.servers.length > 0 ? options : { ...options, servers: [{ url: basePath }] }
}

/**
 * Builds the documentation page and its bundle, or nothing when no UI is served.
 *
 * The page's links are followed by a browser, so they carry the application's base path.
 */
function ui(options: OpenAPIOptions, paths: EndpointPaths, basePath: string): { docsPage?: string; asset?: string } {
  const { docs, asset, json } = paths
  if (docs === undefined || asset === undefined) {
    return {}
  }

  const base = options.routes.base

  return {
    docsPage: scalarPage({
      title: options.info.title,
      // Present: `assertUIHasDocument` refused a UI without a JSON endpoint before the plugin was built.
      specURL: basePath + publicURL(base, json!),
      assetURL: basePath + publicURL(base, asset),
      configuration: options.ui,
    }),
    asset: readScalarBundle(),
  }
}

/**
 * Rejects a `.secure(s => s.schemes(...))` naming a scheme that was never registered.
 *
 * Without this the name matches nothing and the endpoints are protected by the authenticated-user
 * requirement alone — quieter than intended, and invisible until someone tests it.
 */
function assertSchemesExist(container: HTTPSetupContext['container'], options: OpenAPIOptions): void {
  const wanted = options.secure?.schemes ?? []
  if (wanted.length === 0) {
    return
  }

  const provider = container.getOptional(AuthenticationSchemeProvider)
  const known = provider?.schemeNames ?? []

  for (const name of wanted) {
    if (!known.includes(name)) {
      throw new ErrOpenAPIConfiguration(
        errMessage(`Cannot secure the OpenAPI endpoints: no authentication scheme named "${name}" is registered`)
          .solutions(
            known.length === 0
              ? 'Register a scheme with .install(Authentication(auth => auth.addJWTBearer(...))) before securing the document'
              : `Use one of the registered schemes: ${known.map(n => `"${n}"`).join(', ')}`,
          )
          .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
          .build(),
      )
    }
  }
}

/**
 * Warns when a secured application serves its documentation to anyone.
 *
 * Not an error: a public API with authenticated write routes is a normal, correct shape, and the petstore
 * is exactly that. But an unlisted description of every endpoint and every auth scheme is worth one line of
 * output when nobody stated it was intended, and `.public()` silences it.
 */
function warnIfUnprotected(container: HTTPSetupContext['container'], name: string, options: OpenAPIOptions): void {
  if (options.secureExplicit || options.secure !== undefined) {
    return
  }

  // Configuring authentication binds the coordinator, and nothing else does, so its presence is the feature
  // being on.
  if (!container.has(AuthenticationService)) {
    return
  }

  const document = name === DEFAULT_DOCUMENT_NAME ? 'The OpenAPI document' : `The OpenAPI document "${name}"`

  process.emitWarning(
    errMessage(`${document} is served publicly while authentication is configured`)
      .solutions(
        'Call .secure(s => s.schemes("Bearer")) on the OpenAPI builder to require authentication',
        'Call .public() to state that public access is intended and silence this warning',
      )
      .build(),
    'CaffeineOpenAPIWarning',
  )
}

/**
 * Reads an imported document.
 *
 * A `.yaml`/`.yml` file is parsed as YAML and everything else as JSON, because the extension is the only
 * signal available and JSON is the safer default for an unknown one — a JSON document is also valid YAML, so
 * the reverse mistake would parse silently and produce something subtly wrong.
 */
function readDocument(source: OpenAPISource): OpenAPIDocument {
  if (source.kind === 'document') {
    return source.document
  }

  const path = resolve(source.path)

  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ErrOpenAPIConfiguration(
      errMessage(`Cannot read the OpenAPI specification at "${path}": ${describe(cause)}`)
        .solutions(
          'Check the path — it is resolved against the process working directory unless absolute',
          'Pass the document itself with .document(obj) instead of reading it from disk',
        )
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }

  const yaml = ['.yaml', '.yml'].includes(extname(path).toLowerCase())

  try {
    return (yaml ? fromYAML(contents) : JSON.parse(contents)) as OpenAPIDocument
  } catch (cause) {
    throw new ErrOpenAPIConfiguration(
      errMessage(`Cannot parse the OpenAPI specification at "${path}" as ${yaml ? 'YAML' : 'JSON'}: ${describe(cause)}`)
        .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
        .build(),
    )
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
