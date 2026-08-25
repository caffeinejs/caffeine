/**
 * A path parameter discovered while translating a route path, with any constraint the path itself expressed.
 */
export interface PathParameter {
  name: string
  /** A regex the segment must match, taken from Fastify's `:id(...)` syntax, with anchors stripped. */
  pattern?: string
  /** Whether the segment came from a wildcard rather than a named parameter. */
  wildcard?: boolean
}

/** The result of translating one Fastify path into OpenAPI path templates. */
export interface TranslatedPath {
  /**
   * The templates this route answers on. Normally one; a Fastify optional parameter (`/:id?`) produces two,
   * because OpenAPI has no way to mark a path segment optional.
   */
  templates: string[]
  parameters: PathParameter[]
}

/**
 * Joins a router base path and a route path, trimming a trailing slash (but never to empty).
 *
 * A deliberate copy of http's internal `joinPaths`: it is not exported, and the project forbids re-export
 * passthroughs across packages. `openapi/_tests/paths.test.ts` asserts the two agree on a fixture table, so a
 * change on either side surfaces as a failing test rather than as silently divergent URLs.
 */
export function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}

/** The full URL a route answers on, matching how the adapter registers it. */
export function routeURL(prefix: string | undefined, routerPath: string, routePath: string): string {
  return `${prefix ?? ''}${joinPaths(routerPath, routePath)}`
}

// A Fastify path segment: `:name`, optionally `(regex)`, optionally `?`. Kept greedy-free so `:file.:ext`
// splits into two parameters rather than one named `file.:ext`.
const PARAM = /:([A-Za-z0-9_]+)(\(((?:[^()\\]|\\.|\([^)]*\))*)\))?(\?)?/g

/**
 * Translates a Fastify path into OpenAPI path templates.
 *
 * Fastify and OpenAPI disagree about more than the sigil:
 * - `/:id` → `/{id}`, the ordinary case.
 * - `/:id(^\d+$)` → `/{id}`, with the regex lifted onto the parameter's schema as a `pattern`. The anchors
 *   go, because JSON Schema's `pattern` is already an unanchored partial match and Ajv treats `^`/`$` as
 *   literal boundaries — keeping them would be harmless but noisy, and dropping them is what tooling expects.
 * - `/:file.:ext` → `/{file}.{ext}`, two parameters in one segment, which OpenAPI allows.
 * - `/:id?` → two templates. OpenAPI cannot say "this segment may be absent", so the honest translation is
 *   one path item without the segment and one with it, both pointing at the same operation.
 * - `/*` → `/{wildcard}`. Fastify exposes the match as `params['*']`, which is not a legal template name, so
 *   the parameter is renamed and marked for the caller to annotate.
 */
export function translatePath(path: string): TranslatedPath {
  const parameters: PathParameter[] = []
  let optionalFrom: number | undefined

  let template = path.replace(PARAM, (_match, name: string, _group, pattern: string | undefined, optional) => {
    parameters.push({ name, pattern: pattern === undefined ? undefined : stripAnchors(pattern) })
    if (optional !== undefined) {
      optionalFrom ??= parameters.length - 1
    }
    return `{${name}}`
  })

  if (template.includes('*')) {
    template = template.replace(/\*/g, '{wildcard}')
    parameters.push({ name: 'wildcard', wildcard: true })
  }

  if (optionalFrom === undefined) {
    return { templates: [template], parameters }
  }

  // The shorter template drops the optional parameter's whole segment, not just the placeholder, so
  // `/pets/{id}` becomes `/pets` rather than `/pets/`.
  const optionalName = parameters[optionalFrom].name
  const withoutOptional = trimTrailingSlash(template.replace(`/{${optionalName}}`, ''))

  return { templates: [withoutOptional, template], parameters }
}

/** The parameter names a template references, in order. */
export function templateParameters(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
}

function stripAnchors(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '')
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, '') : path || '/'
}
