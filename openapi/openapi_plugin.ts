import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import {
  type AuthSchemeDescriptor,
  AuthenticationSchemeProvider,
  AuthenticationService,
  type HTTPPlugin,
  type RouteGroup,
  kAuthSchemeDescriptors,
  solutions,
} from '@caffeinejs/http'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { parse as fromYAML, stringify as toYAML } from 'yaml'

import type { OpenAPIDocumentStore } from './document_store.js'
import type { EndpointPaths } from './endpoints.js'
import { publicURL } from './endpoints.js'
import { ErrOpenAPIConfiguration } from './errors.js'
import { generateDocument, validateDocument } from './generate/generator.js'
import type { OpenAPIOptions, OpenAPISource } from './options.js'
import type { OpenAPIDocument } from './spec/spec.js'
import { readScalarBundle, scalarPage } from './ui/scalar.js'

/**
 * Generates the document during the server phase and fills the store the endpoints read.
 *
 * The plugin phase is the one moment where every route is resolved and nothing has been registered with
 * Fastify yet, so the document describes the whole application — including routes other plugins contributed.
 * It touches the server itself not at all: the endpoints that serve the document were registered from the
 * builder's bootstrap.
 *
 * Generation is eager and failures are fatal. A malformed document is not something a consumer recovers from
 * at request time, and one that silently omits routes is worse than one that never shipped; the framework
 * already refuses to start on an unconvertible route schema, and this matches it.
 */
export function openapiPlugin(store: OpenAPIDocumentStore, options: OpenAPIOptions, paths: EndpointPaths): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    const descriptors = instance.$container.getOptional<Map<string, AuthSchemeDescriptor>>(kAuthSchemeDescriptors)
    assertSchemesExist(instance, options)
    warnIfUnprotected(instance, options)

    const warnings: string[] = []
    const generated =
      options.source === undefined
        ? generateDocument({
            routeGroups: instance.$routeGroups as Array<RouteGroup<unknown>>,
            options,
            schemes: descriptors,
            onWarning: message => warnings.push(message),
          })
        : readDocument(options.source)

    // The transform runs in both modes, so it is equally the way to patch a generated document and to adjust
    // an imported one. Mutating in place and returning nothing is supported because it is the obvious thing
    // to reach for.
    const document = options.transformDocument?.(generated) ?? generated

    // A generated document is validated by default; an imported one is not, because a hand-written spec may
    // legitimately use constructs the validator rejects. `.validate(true)` opts one back in.
    if (options.validate ?? options.source === undefined) {
      validateDocument(document)
    }

    for (const warning of warnings) {
      process.emitWarning(warning, 'CaffeineOpenAPIWarning')
    }

    store.fill({
      document,
      json: JSON.stringify(document),
      yaml: toYAML(document),
      ...ui(options, paths),
    })
  }

  return fp(plugin, { name: 'openapi' })
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
