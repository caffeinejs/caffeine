import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import {
  AuthenticationSchemeProvider,
  AuthenticationService,
  HTTPPlugin,
  kAuthSchemeDescriptors,
  kErrorHandlingOptions,
  normalizeRoutePath,
  Router,
  routeURL,
  type HTTPPluginFactory,
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
 * `.with(openapi(o => ...))`. Needs `.install(OpenAPI())` on the application. On the application or a listener it
 * documents every route of that server; on a router or a controller, that one's routes, and serves the document under
 * its path. A document name is registered once: a router mounted at two places, or on two servers, cannot carry one.
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
 *   and at start-up when a document of that name is already registered, or its router serves at more than one place.
 */
export function openapi<C = unknown>(configure?: OpenAPIConfigurer<C>): HTTPPluginFactory<C>
export function openapi<C = unknown>(name: string, configure?: OpenAPIConfigurer<C>): HTTPPluginFactory<C>
export function openapi<C = unknown>(
  nameOrConfigure?: string | OpenAPIConfigurer<C>,
  maybeConfigure?: OpenAPIConfigurer<C>,
): HTTPPluginFactory<C> {
  const named = typeof nameOrConfigure === 'string'
  const name = named ? nameOrConfigure : DEFAULT_DOCUMENT_NAME
  const configure = named ? maybeConfigure : nameOrConfigure

  assertDocumentName(name)

  const factory: HTTPPluginFactory<C> = context => {
    // Factories run at start-up: a plugin with nowhere to register its document is a boot failure naming the fix.
    if (!context.hasFeature('openapi')) {
      throw new ErrFeatureNotInstalled('openapi', 'Install it with .install(OpenAPI()) on the application')
    }

    const builder = new OpenAPIOptionsBuilder(name)
    configure?.(builder, context)
    const options = builder[kBuild]()
    assertUIHasDocument(name, options)

    const provider = context.container.get(OpenAPIProvider)
    provider[kReserve](name, factory)

    return new OpenAPIPlugin(name, options, provider)
  }

  return factory
}

/**
 * Collects the routes of its scope as they register and generates the document in `onReady`, once all of them
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
    const { server } = context

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
    context.server.hook('onRoute', ({ route, group }) => {
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

    context.server.hook('onReady', () => {
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

    // Under a prefix or a base that matches more than itself, the page's links are relative to where it was opened, so
    // they keep the path a browser asked for: the values the parameters matched, spelled as the request spelled them.
    const root = `${server.basePath}${server.prefix}`
    const parametric = /[:*]/.test(server.prefix + options.routes.base)
    const docsPage = parametric ? undefined : uiPage(options, paths, root)
    // Relative to the base: the request path already holds the values it matched.
    const docsDepth = paths.docs === undefined ? 0 : segmentsOf(paths.docs)
    const asset = paths.docs === undefined ? undefined : readScalarBundle()
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
      endpoint(router, paths.docs, 'text/html', authz).handler(
        ctx => docsPage ?? uiPage(options, paths, rootFrom(ctx.req.url, docsDepth), '/'),
      )
    }
    if (paths.asset !== undefined) {
      endpoint(router, paths.asset, 'text/javascript', authz)
        .header('cache-control', ASSET_CACHE_CONTROL)
        .handler(() => asset)
    }

    context.server.mount(router)
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
  // As the router routes them: the links name them as they are served, without a trailing "/".
  const docs = routed(routes.docs)

  return {
    json: routed(routes.json),
    yaml: routed(routes.yaml),
    docs,
    asset: docs === undefined ? undefined : assetOf(docs),
  }
}

// Beside the page. A page at "/" puts it at the root, never at "//_scalar.js", which a browser reads as a host.
function assetOf(docs: string): string {
  return docs === '/' ? ASSET_SEGMENT : docs + ASSET_SEGMENT
}

/** A route path as the router routes it: rooted, without a trailing `/`. */
function routed(path: string | undefined): string | undefined {
  return path === undefined ? undefined : normalizeRoutePath(path)
}

/** The URL a browser requests, which includes the router base the routes are mounted under. */
function publicURL(base: string, path: string): string {
  return routeURL(undefined, base, path)
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
 * Builds the documentation page, or nothing when no UI is served.
 *
 * The page's links are followed by a browser, so they start at `root`, then `base`: where the plugin's routes start,
 * and the base its endpoints are under, `/` when `root` already ends there.
 */
function uiPage(
  options: OpenAPIOptions,
  paths: EndpointPaths,
  root: string,
  base = options.routes.base,
): string | undefined {
  const { docs, asset, json } = paths
  if (docs === undefined || asset === undefined) {
    return undefined
  }

  return scalarPage({
    title: options.info.title,
    // Present: `assertUIHasDocument` refused a UI without a JSON endpoint before the plugin was built.
    specURL: root + publicURL(base, json!),
    assetURL: root + publicURL(base, asset),
    configuration: options.ui,
  })
}

/** How many segments a literal path holds. */
function segmentsOf(path: string): number {
  return path.split('/').filter(segment => segment !== '').length
}

/**
 * Where the plugin's endpoints start, under its base, relative to the docs page a request opened. The path the request
 * names ends with the page's `depth` segments, each after one or more `/`: the links climb one level for each `/`
 * after the page's own path starts. A page at a group's root answers at both forms: a trailing `/` lies past the page,
 * and the links climb out of it. A relative link never names another origin.
 */
function rootFrom(url: string, depth: number): string {
  const path = url.slice(0, endOf(url, /[?#]/))
  let at = path.length
  let ups = 0
  let rest = ''

  if (depth === 0) {
    // A page at a group's root: a trailing "/" is the root's second form, past the page.
    while (at > 0 && path[at - 1] === '/') {
      at--
      ups++
    }
    if (ups === 0) {
      rest = path.slice(path.lastIndexOf('/') + 1)
    } else {
      ups--
    }
  }

  // Trailing slashes, then each of the page's segments from the last, with the slashes between them.
  for (let segment = 0; segment < depth; segment++) {
    while (at > 0 && path[at - 1] === '/') {
      at--
      ups++
    }
    while (at > 0 && path[at - 1] !== '/') {
      at--
    }
  }

  const climb = Array.from({ length: ups }, () => '..')
  return [...(climb.length === 0 ? ['.'] : climb), ...(rest === '' ? [] : [rest])].join('/')
}

function endOf(text: string, stop: RegExp): number {
  const at = text.search(stop)
  return at === -1 ? text.length : at
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
