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

export function joinPaths(base: string, path: string): string {
  return `${normalizePath(base)}${normalizePath(path)}` || '/'
}

export function pathParamPattern(key: string): RegExp {
  return new RegExp(`\\{${key}\\}`, 'g')
}
