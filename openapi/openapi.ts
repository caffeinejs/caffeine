import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import {
  AuthenticationSchemeProvider,
  AuthenticationService,
  collectRouteGroups,
  RouteBuilder,
  kAuthSchemeDescriptors,
  solutions,
  type AuthSchemeDescriptor,
  type HTTPPluginFactory,
  type RouteAuthzOptions,
  type RouteGroup,
} from '@caffeinejs/http'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { parse as fromYAML, stringify as toYAML } from 'yaml'

import type { APIGroupDetail } from './decorators/detail.js'
import { kAPIGroup } from './decorators/keys.js'
import { ErrOpenAPIConfiguration } from './errors.js'
import { generateDocument, validateDocument } from './generate/generator.js'
import { joinPaths } from './generate/paths.js'
import { toRouteAuthz, type OpenAPIOptions, type OpenAPISource } from './options.js'
import { kBuild, OpenAPIOptionsBuilder } from './options_builder.js'
import type { OpenAPIDocument } from './spec/spec.js'
import { readScalarBundle, scalarPage } from './ui/scalar.js'

/** Authors {@link OpenAPIOptions} through {@link OpenAPIOptionsBuilder} instead of the plain object. */
export type OpenAPIConfigurer = (builder: OpenAPIOptionsBuilder) => void

/** The path the Scalar bundle is served from, relative to the documentation page. */
const ASSET_SEGMENT = '/_scalar.js'

/** A year. The bundle is immutable at this URL for the process's lifetime. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

interface EndpointPaths {
  json: string
  yaml: string | undefined
  docs: string | undefined
  asset: string | undefined
}

/**
 * Generates and serves an OpenAPI document, as an ordinary Fastify plugin factory: `.with(openapi(o => ...))`.
 *
 * Most of what ends up in the document is not configured here at all — it is read from the routes the
 * application already declares. The builder covers the document-level facts nothing else can know (title,
 * version, servers), where the document is served, and who may read it.
 */
export function openapi<C = unknown>(configure?: OpenAPIConfigurer): HTTPPluginFactory<C> {
  return () => {
    const builder = new OpenAPIOptionsBuilder()
    configure?.(builder)
    return openapiPlugin(builder[kBuild]())
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
function openapiPlugin(options: OpenAPIOptions): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    const descriptors = instance.$container.getOptional<Map<string, AuthSchemeDescriptor>>(kAuthSchemeDescriptors)
    assertSchemesExist(instance, options)
    warnIfUnprotected(instance, options)

    const routeGroups = collectRouteGroups(instance)

    // Assigned in `onReady`, which settles before any request reaches the handlers below.
    let document!: OpenAPIDocument
    let yaml!: string

    instance.addHook('onReady', async () => {
      const warnings: string[] = []
      const generated =
        options.source === undefined
          ? generateDocument({
              routeGroups: routeGroups() as Array<RouteGroup<unknown>>,
              options,
              schemes: descriptors,
              onWarning: message => warnings.push(message),
            })
          : readDocument(options.source)

      // The transform runs in both modes, so it is equally the way to patch a generated document and to adjust
      // an imported one. Mutating in place and returning nothing is supported because it is the obvious thing
      // to reach for.
      document = options.transformDocument?.(generated) ?? generated

      // A generated document is validated by default; an imported one is not, because a hand-written spec may
      // legitimately use constructs the validator rejects. `.validate(true)` opts one back in.
      if (options.validate ?? options.source === undefined) {
        validateDocument(document)
      }

      for (const warning of warnings) {
        process.emitWarning(warning, 'CaffeineOpenAPIWarning')
      }

      yaml = toYAML(document)
    })

    const paths = resolvePaths(options)
    const { docsPage, asset } = ui(options, paths)

    const authz = options.secure === undefined ? undefined : toRouteAuthz(options.secure)

    instance.$route('openapi', router => {
      router.path(options.routes.base)
      router.extras(kAPIGroup, { hidden: true } satisfies APIGroupDetail)
      router.routes(
        [
          route('GET', paths.json, 'application/json', authz).handle(() => document),
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

  return fp(plugin, { name: 'openapi' })
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

/** Builds the documentation page and its bundle, or nothing when no UI is served. */
function ui(options: OpenAPIOptions, paths: EndpointPaths): { docsPage?: string; asset?: string } {
  const { docs, asset, json } = paths
  if (docs === undefined || asset === undefined) {
    return {}
  }

  const base = options.routes.base

  return {
    docsPage: scalarPage({
      title: options.info.title,
      specURL: publicURL(base, json),
      assetURL: publicURL(base, asset),
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
        `Cannot secure the OpenAPI endpoints: no authentication scheme named "${name}" is registered` +
          solutions(
            known.length === 0
              ? 'Register a scheme with .authentication(auth => auth.addJWTBearer(...)) before securing the document'
              : `Use one of the registered schemes: ${known.map(n => `"${n}"`).join(', ')}`,
          ),
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
function warnIfUnprotected(instance: FastifyInstance, options: OpenAPIOptions): void {
  if (options.secureExplicit || options.secure !== undefined) {
    return
  }

  // Configuring authentication binds the coordinator, and nothing else does, so its presence is the feature
  // being on.
  if (!instance.$container.has(AuthenticationService)) {
    return
  }

  process.emitWarning(
    'The OpenAPI document is served publicly while authentication is configured' +
      solutions(
        'Call .secure(s => s.schemes("Bearer")) on the OpenAPI builder to require authentication',
        'Call .public() to state that public access is intended and silence this warning',
      ),
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
      `Cannot read the OpenAPI specification at "${path}": ${describe(cause)}` +
        solutions(
          'Check the path — it is resolved against the process working directory unless absolute',
          'Pass the document itself with .document(obj) instead of reading it from disk',
        ),
    )
  }

  const yaml = ['.yaml', '.yml'].includes(extname(path).toLowerCase())

  try {
    return (yaml ? fromYAML(contents) : JSON.parse(contents)) as OpenAPIDocument
  } catch (cause) {
    throw new ErrOpenAPIConfiguration(
      `Cannot parse the OpenAPI specification at "${path}" as ${yaml ? 'YAML' : 'JSON'}: ${describe(cause)}`,
    )
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
