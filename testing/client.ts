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
      let method: string
      let requestURL: string | undefined

      if (input instanceof Request) {
        method = input.method
        requestURL = input.url
      } else {
        method = (input?.method ?? defaultMethod).toUpperCase()
        requestURL = undefined
      }

      const url = resolveRouteURL(origin, router, route.path, requestURL)

      const request = input instanceof Request
        ? mergeRequest(input, { method, url })
        : new Request(url, { ...input, method, duplex: input?.body ? 'half' : undefined } as RequestInit)

      return fetcher(request)
    }
  }

  return client as TestClient<ROUTER>
}
