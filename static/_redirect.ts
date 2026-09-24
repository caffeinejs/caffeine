const LEADING_SLASHES = /^[/\\]+/

export function rebaseDirectoryRedirect(
  location: string,
  status: number | undefined,
  url: string | undefined,
  basePath: string,
): string {
  if (basePath === '' || status !== 301 || url === undefined) {
    return location
  }

  return location === directoryURL(url) ? basePath + location : location
}

// Mirrors `getRedirectUrl` in `@fastify/static`, which builds every redirect it makes from the request's URL.
function directoryURL(url: string): string {
  const { pathname, search } = new URL(url.replace(LEADING_SLASHES, '/'), 'http://localhost/')

  return pathname + (pathname.endsWith('/') ? '' : '/') + search
}
