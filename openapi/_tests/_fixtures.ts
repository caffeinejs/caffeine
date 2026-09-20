import { mergeAuthz, RouteBuilder, type Route, type RouteGroup, type RouteGroupBuilder } from '@caffeinejs/http'
import { getRouteGroup, registerRouteGroup } from '@caffeinejs/http/decorators/registrar'

import type { OpenAPIOptions } from '../options.js'
import { defaultOpenAPIOptions } from '../options.js'

/**
 * Builds a `RouteGroup` the way `buildRouting` would, without a container or a running application.
 *
 * The generator only ever reads `RouteGroup`/`Route`, so a fixture producing that shape exercises it honestly and
 * keeps a unit test to milliseconds. The integration tests drive a real application instead, which is what
 * proves the fixture and the real thing agree.
 */
export function fixtureRouter(
  path: string,
  configure: (router: RouteGroupBuilder) => void,
  options: { prefix?: string; name?: string; defaultScheme?: string } = {},
): RouteGroup<unknown> {
  // A fresh class per call: `registerRouteGroup` is get-or-create and `routes()` appends, so a shared key would
  // accumulate the routes of every previous fixture.
  const name = options.name ?? 'FixtureController'
  const key = { [name]: class {} }[name] as unknown as Function

  registerRouteGroup(key, router => {
    router.path(path)
    configure(router)
  })

  const spec = getRouteGroup(key)!.toRouteGroup<unknown>()

  return {
    path: spec.path,
    prefix: options.prefix ?? spec.prefix,
    name: name,
    target: key,
    detail: spec.detail,
    routes: spec.routes.map((route): Route<unknown> => {
      // Mirrors buildRouting: anything declared at either level is protection unless the result is public.
      const authz = mergeAuthz(spec.authz, route.authz)
      // Also mirrors buildRouting: the effective schemes are folded while the route compiles, so a route
      // naming none carries the application's default rather than leaving the generator to find it.
      const named = authz?.schemes
      const schemes =
        named !== undefined && named.length > 0
          ? named
          : options.defaultScheme === undefined
            ? []
            : [options.defaultScheme]

      return {
        path: route.path,
        method: route.method,
        accept: route.accept.length > 0 ? route.accept : spec.accept,
        contentType: route.contentType !== '' ? route.contentType : spec.contentType,
        parameters: route.parameters,
        name: route.name,
        dispatch: () => () => undefined,
        schema: route.schema,
        statusCode: route.statusCode,
        detail: route.detail,
        authorization: {
          hasProtection: authz !== undefined && !authz.allowAnonymous,
          options: authz,
          schemes,
        },
      }
    }),
  }
}

/** A route builder with the method, path and name already set. */
export function fixtureRoute(method: string, path: string, name: string): RouteBuilder {
  return new RouteBuilder().method(method).path(path).name(name)
}

export function fixtureOptions(overrides: Partial<OpenAPIOptions> = {}): OpenAPIOptions {
  return { ...defaultOpenAPIOptions(), ...overrides }
}
