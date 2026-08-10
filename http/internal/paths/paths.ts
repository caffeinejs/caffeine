/** Joins a router base path and a route path, trimming a trailing slash (but never to empty). */
export function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}
