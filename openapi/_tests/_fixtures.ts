import { RouteBuilder, type Route, type RouteGroup, type RouteGroupBuilder } from '@caffeinejs/http'
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
  options: { prefix?: string; name?: string } = {},
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
    extras: spec.extras,
    routes: spec.routes.map((route): Route<unknown> => {
      // Mirrors buildRouting: any authz declared at either level is protection unless something opted out.
      const hasDecoratorProtection = spec.authz !== undefined || route.authz !== undefined
      const isAnonymous = !!(spec.authz?.allowAnonymous || route.authz?.allowAnonymous)

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
        extras: route.extras,
        authorization: {
          hasProtection: hasDecoratorProtection && !isAnonymous,
          options: route.authz ?? spec.authz,
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
