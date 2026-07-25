import type { RouterDescriptor } from './types.js'

export function resolveRouteURL(
  baseURL: string,
  router: RouterDescriptor,
  routePath: string,
  requestURL?: string,
): string {
  const origin = baseURL.replace(/\/+$/, '')
  const prefix = router.prefix ?? ''
  const segments = [prefix, router.path, routePath].filter(s => s.length > 0)
  const joined = segments.join('/').replace(/\/+/g, '/')
  const rawPath = joined.startsWith('/') ? joined : `/${joined}`
  const path = joinPaths('', rawPath)
  const url = new URL(path, `${origin}/`)

  if (requestURL) {
    const incoming = new URL(requestURL, `${origin}/`)
    for (const [key, value] of incoming.searchParams) {
      url.searchParams.append(key, value)
    }
  }

  return url.toString()
}

export function mergeRequest(request: Request, overrides: { method: string, url: string }): Request {
  return new Request(overrides.url, {
    method: overrides.method,
    headers: request.headers,
    body: request.body,
    duplex: request.body ? 'half' : undefined,
    redirect: request.redirect,
    signal: request.signal,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  } as RequestInit)
}

function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}
