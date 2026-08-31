import type { Container } from '@caffeinejs/di'
import { Keys, RouteBuilder, type RouteAuthzOptions } from '@caffeinejs/http'
import { registerRouter } from '@caffeinejs/http/decorators/registrar'
import type { OpenAPIDocumentStore } from './document_store.js'
import { kOpenAPISelf } from './keys.js'
import type { OpenAPIOptions } from './options.js'
import { joinPaths } from './generate/paths.js'

/** The path the Scalar bundle is served from, relative to the documentation page. */
const ASSET_SEGMENT = '/_scalar.js'

/** A year. The bundle is immutable at this URL for the process's lifetime. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export interface EndpointPaths {
  json: string
  yaml: string | undefined
  docs: string | undefined
  asset: string | undefined
}

/**
 * Registers the routes that serve the document, as ordinary routes.
 *
 * The health probes mount straight onto the Fastify instance so they can *escape* the authentication hook,
 * which runs per controller scope. These endpoints need the opposite: going through the normal routing path
 * is what makes them protectable at all, and it means authentication, authorization, error handling, content
 * negotiation and every user-registered server extension applies to them exactly as they do to any other
 * route — none of it reimplemented here.
 *
 * Must run before `buildRouting`, which `configure()` guarantees.
 */
export function registerEndpoints(
  container: Container,
  store: OpenAPIDocumentStore,
  options: OpenAPIOptions,
  authz: RouteAuthzOptions | undefined,
): EndpointPaths {
  const paths = resolvePaths(options)

  // A fresh class per builder, never a module-level one. `registerRouter` is get-or-create and `routes()`
  // appends, so a shared identity would accumulate a duplicate route for every application built in the
  // process, and Fastify rejects the second registration outright.
  const endpoints = class OpenAPIEndpoints {
    json(): unknown {
      return store.document
    }

    yaml(): string {
      return store.yaml
    }

    docs(): string {
      return store.docsPage
    }

    asset(): string {
      return store.asset
    }
  }

  container.bind(endpoints).toValue(new endpoints()).labels(Keys.CONTROLLER)

  registerRouter(endpoints, router => {
    router.path(options.routes.base)
    router.extras(kOpenAPISelf, true)

    const routes = [
      route('GET', paths.json, 'json', 'application/json', authz),
      paths.yaml === undefined ? undefined : route('GET', paths.yaml, 'yaml', 'application/yaml', authz),
      paths.docs === undefined ? undefined : route('GET', paths.docs, 'docs', 'text/html', authz),
      paths.asset === undefined
        ? undefined
        : route('GET', paths.asset, 'asset', 'text/javascript', authz)
            .header('cache-control', ASSET_CACHE_CONTROL),
    ].filter((value): value is RouteBuilder => value !== undefined)

    router.routes(routes)
  })

  return paths
}

/**
 * Builds one endpoint route.
 *
 * `authorize` is called only when protection was actually configured. Routing reads *any* defined authz —
 * including an empty object — as protection, and an application with no authentication then refuses to start
 * with "authorization is configured but authentication is not". Passing `{}` to mean "public" would break
 * every unauthenticated application that turns documentation on.
 */
function route(
  method: string,
  path: string,
  name: string,
  contentType: string,
  authz: RouteAuthzOptions | undefined,
): RouteBuilder {
  const builder = new RouteBuilder()
    .method(method)
    .path(path)
    .name(name)
    .produces(contentType)

  if (authz !== undefined) {
    builder.authorize(authz)
  }

  return builder
}

/**
 * Resolves the configured paths against the base, and derives the asset path from the docs path so the bundle
 * always sits beside the page that loads it.
 */
export function resolvePaths(options: OpenAPIOptions): EndpointPaths {
  const { routes } = options

  return {
    json: routes.json,
    yaml: routes.yaml,
    docs: routes.docs,
    asset: routes.docs === undefined ? undefined : `${routes.docs}${ASSET_SEGMENT}`,
  }
}

/** The URL a browser requests, which includes the router base the routes are mounted under. */
export function publicURL(base: string, path: string): string {
  return joinPaths(base === '/' ? '' : base, path)
}
