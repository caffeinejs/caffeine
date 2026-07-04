import { getRouter } from '@caffeinejs/application'
import { ErrNoRouter } from './error.js'
import { mergeRequest, resolveRouteUrl } from './_util.js'
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
      let requestUrl: string | undefined

      if (input instanceof Request) {
        method = input.method
        requestUrl = input.url
      } else {
        method = (input?.method ?? defaultMethod).toUpperCase()
        requestUrl = undefined
      }

      const url = resolveRouteUrl(origin, router, route.path, requestUrl)

      const request = input instanceof Request
        ? mergeRequest(input, { method, url })
        : new Request(url, { ...input, method, duplex: input?.body ? 'half' : undefined } as RequestInit)

      return fetcher(request)
    }
  }

  return client as TestClient<ROUTER>
}
