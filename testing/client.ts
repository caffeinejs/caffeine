import { getRouter } from '@caffeinejs/http'
import { ErrNoRoutesForController } from './error.js'
import { mergeRequest, resolveRouteUrl } from './_util.js'
import type { Fetchable, RouterCtor, TestClient } from './types.js'

export function testClient<ROUTER extends RouterCtor>(
  routerRef: ROUTER,
  target: string | URL | Fetchable,
): TestClient<ROUTER> {
  const descriptor = getRouter(routerRef)
  if (!descriptor) {
    throw new ErrNoRoutesForController(routerRef.name)
  }

  const isRemote = typeof target === 'string' || target instanceof URL
  const origin = isRemote ? target.toString() : 'http://localhost'
  const dispatch = isRemote ? fetch : target.fetch.bind(target)

  const router = descriptor.describe()
  const client: Record<string | symbol, (input: Request | RequestInit) => Promise<Response>> = {}

  for (const route of router.routes) {
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

      return dispatch(request)
    }
  }

  return client as TestClient<ROUTER>
}
