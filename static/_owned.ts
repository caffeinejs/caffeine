import type { RouteGroup } from '@caffeinejs/http'

/**
 * The static path prefixes the server owns, derived from the compiled routing.
 *
 * Derived rather than configured because a hand-written exclude list drifts the moment a controller is added
 * or renamed, and nothing reports it: the application keeps booting and starts answering an API miss with an
 * HTML document.
 *
 * A controller contributes its **base** path (`@Prefix` + `@Controller`), not its individual route URLs:
 * `@Controller('/api')` declaring only `@Get('/')` owns all of `/api`, so `/api/typo` stays a 404 instead of
 * falling through to a shell. A base that is empty or `/` would own the whole origin and leave a shell nothing
 * to answer, so those controllers contribute their route paths instead.
 *
 * Paths are truncated at the first dynamic segment, since `/users/:id` tells us the server owns `/users`, and a
 * wildcard route owns nothing beyond its static part, so a shell's own `/*` contributes nothing.
 */
export function deriveServerOwnedPaths(routeGroups: readonly RouteGroup<any>[]): string[] {
  const owned = new Set<string>()

  for (const router of routeGroups) {
    const base = staticPrefix(`${router.prefix ?? ''}${router.path}`)

    if (base !== '' && base !== '/') {
      owned.add(base)
      continue
    }

    // A controller mounted at the root owns no prefix of its own, so it speaks for its routes individually.
    for (const route of router.routes) {
      const path = staticPrefix(`${router.prefix ?? ''}${router.path}${route.path}`)

      if (path !== '' && path !== '/') {
        owned.add(path)
      }
    }
  }

  return [...owned].sort()
}

/**
 * Whether `path` falls under one of `owned`.
 *
 * Segment-aware on purpose: a plain `startsWith` would put `/apifoo` under `/api`.
 */
export function isServerOwned(owned: readonly string[], path: string): boolean {
  return owned.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/** The leading static portion of a route path: everything before the first `:param` or `*` segment. */
function staticPrefix(path: string): string {
  // A controller mounted at '/' joins to '//health', since the paths are only concatenated.
  const segments = path.replace(/\/{2,}/g, '/').split('/')
  const stable: string[] = []

  for (const segment of segments) {
    if (segment.startsWith(':') || segment.startsWith('*')) {
      break
    }

    stable.push(segment)
  }

  const joined = stable.join('/')

  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}
