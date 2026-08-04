import { getRouter } from '@caffeinejs/http'
import { ErrNoRouter } from './error.js'
import { mergeRequest, resolveRouteURL } from './_util.js'
import type { Fetchable, RouterCtor, TestClient } from './types.js'

export function testClient<ROUTER extends RouterCtor>(
  routerRef: ROUTER,
  target: string | URL | Fetchable,
): TestClient<ROUTER> {
  const descriptor = getRouter(routerRef)
  if (!descriptor) {
    throw new ErrNoRouter(String(routerRef))
  }

  const isRemote = typeof target === 'string' || target instanceof URL
  const origin = isRemote ? target.toString() : 'http://localhost'
  const fetcher = isRemote ? fetch : target.fetch.bind(target)

  const router = descriptor.describe()
  const client: Record<string | symbol, (input: Request | RequestInit) => Promise<Response>> = {}

  for (const route of router.routes) {
    // we stick with just one HTTP method.
    // HTTP method can still be overridden by passing a new RequestInit parameter.
    const defaultMethod = route.method[0].toUpperCase()

    client[route.handler] = async (input?: Request | RequestInit) => {
      // A Request carries its own concrete path (e.g. built via newURL for a param route): honor it,
      // rebasing path + query onto the client's origin so remote/in-process targeting is preserved.
      // A RequestInit has no URL, so resolve the route's template path (parameterless routes).
      if (input instanceof Request) {
        const incoming = new URL(input.url, `${origin}/`)
        const url = new URL(incoming.pathname + incoming.search, `${origin}/`).toString()

        return fetcher(mergeRequest(input, { method: input.method, url }))
      }

      const method = (input?.method ?? defaultMethod).toUpperCase()
      const url = resolveRouteURL(origin, router, route.path)
      const request = new Request(url, { ...input, method, duplex: input?.body ? 'half' : undefined } as RequestInit)

      return fetcher(request)
    }
  }

  return client as TestClient<ROUTER>
}
