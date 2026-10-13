/**
 * The URL a compiled route answers on, as the adapter registers it: the group's prefix, then the group's path and the
 * route's joined with a trailing slash trimmed, never to empty. A group at `/devtools` with a route at `/` answers on
 * `/devtools` alone.
 *
 * The server's base path is not part of it: the adapter strips that from a request's URL before matching.
 */
export function routeURL(prefix: string | undefined, groupPath: string, routePath: string): string {
  const joined = `${groupPath}${routePath}`
  return `${prefix ?? ''}${joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'}`
}
