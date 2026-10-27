import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import {
  AuthenticationSchemeProvider,
  AuthenticationService,
  RouteBuilder,
  kAuthSchemeDescriptors,
  type AuthSchemeDescriptor,
  type RouteAuthzOptions,
  type IRouteGroup,
} from '@caffeinejs/http'
import { collectRouteGroups, type HTTPPluginConfigurer, type HTTPPluginFactory } from '@caffeinejs/http/fastify'
import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
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
 * Generates an OpenAPI document, registers it with `OpenAPIProvider`, and serves it, as an ordinary Fastify plugin
 * factory: `.with(openapi(o => ...))`. Needs `.install(OpenAPI())` on the application.
 *
 * Most of what ends up in the document is not configured here at all — it is read from the routes the
 * application already declares. The builder covers the document-level facts nothing else can know (title,
 * version, servers), where the document is served, and who may read it.
 *
 * Without a name the document is `default`. Name each one to register several, on one server or one per listener:
 *
 * ```ts
 * .install(OpenAPI())
 * .with(openapi('public', o => o.include((group, route) => !group.path.startsWith('/admin'))))
 * .with(openapi('admin', o => o.include((group, route) => group.path.startsWith('/admin'))))
 * ```
 *
 * @throws ErrOpenAPIConfiguration when the name is not letters, digits, `-` and `_`, starting with a letter or digit.
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

    return openapiPlugin(name, options, provider)
  }
}

/**
 * Collects the application's routes as they register and generates the document in `onReady`, once all of
 * them have — whichever order the plugins that contributed them were installed in. The routes that serve the
 * document are real, protectable routes registered through `instance.$route(...)`, marked hidden so the
 * document never describes them.
 *
 * Failures are fatal to start-up. A malformed document is not something a consumer recovers from at request
 * time, and one that silently omits routes is worse than one that never shipped; the framework already
 * refuses to start on an unconvertible route schema, and this matches it.
 */
function openapiPlugin(name: string, options: OpenAPIOptions, provider: OpenAPIProvider): FastifyPluginAsync {
  const label = name === DEFAULT_DOCUMENT_NAME ? 'openapi' : `openapi:${name}`
  const paths = resolvePaths(options)
  const served = paths.json !== undefined || paths.yaml !== undefined || paths.docs !== undefined

  const plugin: FastifyPluginAsync = async instance => {
    const descriptors = instance.$container.getOptional<Map<string, AuthSchemeDescriptor>>(kAuthSchemeDescriptors)
    assertSchemesExist(instance, options)
    if (served) {
      warnIfUnprotected(instance, name, options)
    }

    const routeGroups = collectRouteGroups(instance)

    // Assigned in `onReady`, which settles before any request reaches the handlers below.
    let document!: OpenAPIDocument
    let yaml!: string

    instance.addHook('onReady', async () => {
      const warnings: string[] = []
      const generated =
        options.source === undefined
          ? generateDocument({
              routeGroups: included(routeGroups() as Array<IRouteGroup<unknown>>, options),
              options: withBasePathServer(options, instance.$basePath),
              schemes: descriptors,
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

      // A copy, so freezing it touches none of the objects the application handed the builder; frozen, so no
      // consumer of the provider can change what the endpoints serve.
      document = deepFreeze(structuredClone(transformed))
      yaml = toYAML(document)
      provider[kPublish](name, document)
    })

    if (!served) {
      return
    }

    const { docsPage, asset } = ui(options, paths, instance.$basePath)

    const authz = options.secure === undefined ? undefined : toRouteAuthz(options.secure)

    instance.$route(label, router => {
      router.path(options.routes.base)
      router.detail('openapi', { hidden: true })
      router.routes(
        [
          paths.json === undefined
            ? undefined
            : route('GET', paths.json, 'application/json', authz).handle(() => document),
          paths.yaml === undefined ? undefined : route('GET', paths.yaml, 'application/yaml', authz).handle(() => yaml),
          paths.docs === undefined ? undefined : route('GET', paths.docs, 'text/html', authz).handle(() => docsPage),
          paths.asset === undefined
            ? undefined
            : route('GET', paths.asset, 'text/javascript', authz)
                .handle(() => asset)
                .header('cache-control', ASSET_CACHE_CONTROL),
        ].filter((r): r is RouteBuilder => r !== undefined),
      )
    })
  }

  return fp(plugin, { name: label })
}

/** The route groups narrowed to the routes `include` accepts, dropping a group left with none. */
function included(groups: Array<IRouteGroup<unknown>>, options: OpenAPIOptions): Array<IRouteGroup<unknown>> {
  const { include } = options
  if (include === undefined) {
    return groups
  }

  return groups
    .map(group => ({ ...group, routes: group.routes.filter(r => include(group, r)) }))
    .filter(group => group.routes.length > 0)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }

  return value
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
 * Builds one endpoint route.
 *
 * `authorize` is called only when protection was actually configured. Routing reads *any* defined authz —
 * including an empty object — as protection, and an application with no authentication then refuses to start
 * with "authorization is configured but authentication is not". Passing `{}` to mean "public" would break
 * every unauthenticated application that turns documentation on.
 */
function route(method: string, path: string, contentType: string, authz: RouteAuthzOptions | undefined): RouteBuilder {
  const builder = new RouteBuilder().method(method).path(path).produces(contentType)

  if (authz !== undefined) {
    builder.authorize(authz)
  }

  return builder
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
function assertSchemesExist(instance: FastifyInstance, options: OpenAPIOptions): void {
  const wanted = options.secure?.schemes ?? []
  if (wanted.length === 0) {
    return
  }

  const provider = instance.$container.getOptional(AuthenticationSchemeProvider)
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
function warnIfUnprotected(instance: FastifyInstance, name: string, options: OpenAPIOptions): void {
  if (options.secureExplicit || options.secure !== undefined) {
    return
  }

  // Configuring authentication binds the coordinator, and nothing else does, so its presence is the feature
  // being on.
  if (!instance.$container.has(AuthenticationService)) {
    return
  }

  process.emitWarning(
    errMessage(
      `The OpenAPI document${name === DEFAULT_DOCUMENT_NAME ? '' : ` "${name}"`} is served publicly while ` +
        'authentication is configured',
    )
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
