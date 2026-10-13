import { Router, routeURL, type Route, type RouteGroup } from '@caffeinejs/http'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsRoute, DevToolsRoutesReport } from '../wire.js'

/**
 * Every group in the application's route table, on every server, `GET <path>/routes`, each naming the ops server it
 * is bound to: the controllers', and the routers mounted by the application or by a plugin factory, DevTools' own and
 * an OpenAPI document's among them. A path is the one the server matches, without the application's base path.
 *
 * A route a plugin registers straight on a server is not listed: the health probes, the OIDC routes, static files.
 */
export function routes(): DevToolsSlice {
  return {
    id: 'routes',
    router: ({ routeGroups }) => new Router().get('/', () => report(routeGroups)),
  }
}

function report(groups: readonly RouteGroup<unknown>[]): DevToolsRoutesReport {
  return {
    groups: groups.map(group => ({
      name: group.name,
      server: group.boundTo,
      routes: group.routes.map(route => entry(group, route)),
    })),
  }
}

function entry(group: RouteGroup<unknown>, route: Route<unknown>): DevToolsRoute {
  const declared = route.authorization.options

  return {
    name: typeof route.name === 'symbol' ? (route.name.description ?? '') : route.name,
    methods: [...new Set(route.method.map(method => method.toUpperCase()))],
    path: routeURL(group.prefix, group.path, route.path),
    status: route.statusCode,
    produces: route.contentType === '' ? undefined : route.contentType,
    consumes: [...route.accept],
    guards: route.guards?.length ?? 0,
    authorization: {
      hasProtection: route.authorization.hasProtection,
      allowAnonymous: declared?.allowAnonymous ?? false,
      defaultPolicy: declared?.defaultPolicy ?? false,
      policies: [...(declared?.policies ?? [])],
      roles: (declared?.roleGroups ?? []).map(roles => [...roles]),
      schemes: [...route.authorization.schemes],
    },
  }
}
