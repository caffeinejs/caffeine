/** Joins a router base path and a route path, trimming a trailing slash (but never to empty). */
export function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/**
 * The paths a route registers under. A prefixed root is served at the prefix and with a trailing slash, as Fastify's
 * `prefixTrailingSlash: 'both'` serves it.
 */
export function pathsOf(prefix: string | undefined, url: string, ignoreTrailingSlash: boolean): string[] {
  const path = url === '' ? '/' : url
  const base = prefix === undefined ? '' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  if (base === '') {
    return [path]
  }

  if (path === '/') {
    return ignoreTrailingSlash ? [base] : [base, `${base}/`]
  }

  return [base + path]
}
