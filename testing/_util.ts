import { joinURL } from '@caffeinejs/brewer'

import type { RouterDescriptor } from './types.js'

// Joins prefix + controller path + route path into a single leading-slash path template,
// e.g. { prefix: '/api', path: '/tasks' } + '/:id' → '/api/tasks/:id'.
export function joinRoutePath(router: RouterDescriptor, routePath: string): string {
  const prefix = router.prefix ?? ''
  const segments = [prefix, router.path, routePath].filter(s => s.length > 0)
  const joined = segments.join('/').replace(/\/+/g, '/')
  const rawPath = joined.startsWith('/') ? joined : `/${joined}`
  return trimTrailingSlash(rawPath)
}

// Joined, not resolved: `new URL('/tasks', 'https://gateway.example/api/')` is `https://gateway.example/tasks`, and a
// base URL naming the application's base path has to keep it.
export function resolveRouteURL(baseURL: string, router: RouterDescriptor, routePath: string): string {
  return new URL(joinURL(baseURL.replace(/\/+$/, ''), joinRoutePath(router, routePath))).toString()
}

export function mergeRequest(request: Request, overrides: { method: string; url: string }): Request {
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

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, '') : path || '/'
}
