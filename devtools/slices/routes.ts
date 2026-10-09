import { RouteBuilder, routeURL, type Route, type RouteGroup } from '@caffeinejs/http'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsRoute, DevToolsRoutesReport } from '../wire.js'

/**
 * The routes the application's controllers and routers declared, on every server, `GET <path>/routes`, each group
 * naming the ops server it is bound to. A path is the one the server matches, without the application's base path.
 *
 * What a plugin registers on a server itself is not listed: DevTools' own endpoints, the health probes, an OpenAPI
 * document, static files.
 */
export function routes(): DevToolsSlice {
  return {
    id: 'routes',
    routes: ({ routeGroups }) => [
      new RouteBuilder()
        .method('GET')
        .path('/')
        .handle(() => report(routeGroups)),
    ],
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
