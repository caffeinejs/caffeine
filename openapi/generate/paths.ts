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

  const constraintEnds = findConstraintEnds(path)
  const parts: string[] = []
  let from = 0
  const param = /:([A-Za-z0-9_]+)/g
  let match: RegExpExecArray | null
  while ((match = param.exec(path)) !== null) {
    const name = match[1]
    let end = param.lastIndex
    const constraintEnd = constraintEnds.get(end)
    const pattern = constraintEnd === undefined ? undefined : path.slice(end + 1, constraintEnd)
    if (constraintEnd !== undefined) {
      end = constraintEnd + 1
    }
    parameters.push({ name, pattern: pattern === undefined ? undefined : stripAnchors(pattern) })
    if (path[end] === '?') {
      optionalFrom ??= parameters.length - 1
      end++
    }
    parts.push(path.slice(from, match.index), `{${name}}`)
    from = end
    param.lastIndex = end
  }
  parts.push(path.slice(from))
  let template = parts.join('')

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
  const names: string[] = []
  let from = 0
  while (from < template.length) {
    const start = template.indexOf('{', from)
    if (start === -1) {
      break
    }
    const end = template.indexOf('}', start + 1)
    if (end === -1) {
      break
    }
    if (end > start + 1) {
      names.push(template.slice(start + 1, end))
    }
    from = end + 1
  }
  return names
}

// Pair constraints once so an unclosed constraint cannot rescan the suffix for every parameter.
function findConstraintEnds(path: string): Map<number, number> {
  const ends = new Map<number, number>()
  const openings: number[] = []
  for (let index = 0; index < path.length; index++) {
    if (path[index] === '\\') {
      index++
    } else if (path[index] === '(') {
      openings.push(index)
    } else if (path[index] === ')') {
      const start = openings.pop()
      if (start !== undefined) {
        ends.set(start, index)
      }
    }
  }
  return ends
}

function stripAnchors(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '')
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, '') : path || '/'
}
