import { joinURL } from '@caffeinejs/brewer'
import { getRouteGroup } from '@caffeinejs/http'

import { mergeRequest, resolveRouteURL, withoutTrailingSlashes } from './_util.js'
import { ErrNoRouter } from './error.js'
import type { Fetchable, HandlerClient, RouteMethods, RouterCtor } from './types.js'

export type ControllerTestClient<C extends RouterCtor> = {
  [H in RouteMethods<C>]: HandlerClient
}

export function controllerClient<ROUTER extends RouterCtor>(
  routerRef: ROUTER,
  target: string | URL | Fetchable,
): ControllerTestClient<ROUTER> {
  const descriptor = getRouteGroup(routerRef)
  if (!descriptor) {
    throw new ErrNoRouter(String(routerRef))
  }

  const isRemote = typeof target === 'string' || target instanceof URL
  const origin = isRemote ? target.toString() : 'http://localhost'
  const fetcher = isRemote ? fetch : target.fetch.bind(target)

  const router = descriptor.toRouteGroup()
  const client: Record<string | symbol, (input: Request | RequestInit) => Promise<Response>> = {}

  for (const route of router.routes) {
    // we stick with just one HTTP method.
    // HTTP method can still be overridden by passing a new RequestInit parameter.
    const defaultMethod = route.method[0].toUpperCase()

    client[route.name] = async (input?: Request | RequestInit) => {
      // A Request carries its own concrete path (e.g. built via newURL for a param route): honor it,
      // rebasing path + query onto the client's origin so remote/in-process targeting is preserved. One already
      // under that origin — base path included — goes as it is, or the base would be put in twice.
      // A RequestInit has no URL, so resolve the route's template path (parameterless routes).
      if (input instanceof Request) {
        return fetcher(mergeRequest(input, { method: input.method, url: rebase(input.url, origin) }))
      }

      const method = (input?.method ?? defaultMethod).toUpperCase()
      const url = resolveRouteURL(origin, router, route.path)
      const request = new Request(url, { ...input, method, duplex: input?.body ? 'half' : undefined } as RequestInit)

      return fetcher(request)
    }
  }

  return client as ControllerTestClient<ROUTER>
}

/**
 * A request's URL, moved onto `origin`: its path and query joined under it, since `origin` may name the
 * application's base path. A URL already under `origin` is returned as it is.
 */
function rebase(url: string, origin: string): string {
  const base = withoutTrailingSlashes(origin)

  if (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) {
    return url
  }

  const incoming = new URL(url, `${base}/`)
  return new URL(`${joinURL(base, incoming.pathname)}${incoming.search}`).toString()
}
