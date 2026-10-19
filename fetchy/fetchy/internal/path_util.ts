export function normalizePath(path: string): string {
  if (!path) {
    return ''
  }

  let normalized = path.startsWith('/') ? path : `/${path}`

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.substring(0, normalized.length - 1)
  }

  return normalized
}

// Empty when neither has a path: the request builder decides what that calls, the base URL's own path or the root. A base
// of `/` alone, as `@API('/')` writes, adds nothing: the path after it brings its own slash.
export function joinPaths(base: string, path: string): string {
  const prefix = normalizePath(base)

  return `${prefix === '/' ? '' : prefix}${normalizePath(path)}`
}
