import { parseRoutePattern } from '@caffeinejs/http'

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
 * Translates a route path, in Caffeine's route syntax, into OpenAPI path templates.
 *
 * The route syntax and OpenAPI disagree about more than the sigil:
 * - `/:id` → `/{id}`, the ordinary case.
 * - `/:id(^\d+$)` → `/{id}`, with the regex lifted onto the parameter's schema as a `pattern`. The anchors
 *   go, because JSON Schema's `pattern` is already an unanchored partial match and Ajv treats `^`/`$` as
 *   literal boundaries — keeping them would be harmless but noisy, and dropping them is what tooling expects.
 * - `/:file.:ext` → `/{file}.{ext}`, two parameters in one segment, which OpenAPI allows.
 * - `/:id?` → two templates, and `/:id.json?` likewise, the whole segment being optional. OpenAPI cannot say
 *   "this segment may be absent", so the honest translation is one path item without the segment and one with it,
 *   both pointing at the same operation.
 * - `/*` → `/{wildcard}`. The router exposes the match as `params['*']`, which is not a legal template name, so
 *   the parameter is renamed and marked for the caller to annotate.
 */
export function translatePath(path: string): TranslatedPath {
  const parameters: PathParameter[] = []
  let template = ''
  let optionalFrom: number | undefined

  for (const part of parseRoutePattern(path)) {
    if (part.kind === 'text') {
      template += part.text
    } else if (part.kind === 'wildcard') {
      template += '{wildcard}'
      parameters.push({ name: 'wildcard', wildcard: true })
    } else if (part.kind === 'optional') {
      optionalFrom = template.length
    } else {
      template += `{${part.name}}`
      parameters.push({ name: part.name, pattern: part.regex === undefined ? undefined : stripAnchors(part.regex) })
    }
  }

  if (optionalFrom === undefined) {
    return { templates: [template], parameters }
  }

  // The shorter template drops the optional segment and keeps what precedes it as the router serves it: `/pets/{id}`
  // becomes `/pets`, `/a//{id}` becomes `/a/`, `/pets/{id}/` becomes `/pets/`, and `/{id}` becomes `/`.
  const shorter = `${template.slice(0, optionalFrom)}${template.endsWith('/') ? '/' : ''}`
  return { templates: [shorter === '' ? '/' : shorter, template], parameters }
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

function stripAnchors(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '')
}
