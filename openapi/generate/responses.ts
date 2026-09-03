import type { Route } from '@caffeinejs/http'

import type { ResponseDetail } from '../decorators/detail.js'
import type { OpenAPIOptions } from '../options.js'
import type { HeaderObject, ResponseObject } from '../spec/spec.js'
import type { ComponentRegistry } from './components.js'

/** Standard reason phrases, used when nobody wrote a description. */
const REASONS: Record<string, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  '1XX': 'Informational',
  '2XX': 'Success',
  '3XX': 'Redirection',
  '4XX': 'Client Error',
  '5XX': 'Server Error',
}

/**
 * Derives an operation's responses.
 *
 * `@Schema({ response })` is the source of truth for which statuses a route answers and what each returns.
 * That is deliberate and it is the whole rule: error *classes* are never consulted. `@CatchWith` says which
 * handler renders a failure, not which statuses the route emits, and a route that answers 404 says so in its
 * schema — where the declaration also drives Fastify's serialization, so it earns its keep twice.
 *
 * Two additions come from route metadata that is unambiguous rather than from a schema, and both are opt-out:
 * the validation failure Ajv produces whenever a request slot has a schema, and the 401/403 pair on a route
 * the authorization pipeline protects. Anything declared explicitly always wins over an inferred entry.
 */
export function deriveResponses(
  route: Route<unknown>,
  options: OpenAPIOptions,
  registry: ComponentRegistry,
  context: string,
  groupResponses: Record<number | string, ResponseDetail> | undefined,
  operationResponses: Record<number | string, ResponseDetail> | undefined,
): Record<string, ResponseObject> {
  const responses = new Map<string, ResponseObject>()

  // 1. Success, from @Status and @Produces. A 204 carries no content by definition.
  const successStatus = String(route.statusCode ?? 200)
  const successTypes = responseMediaTypes(route)
  const headers = deriveHeaders(route)

  responses.set(successStatus, {
    description: REASONS[successStatus] ?? 'Success',
    ...(headers === undefined ? {} : { headers }),
    ...(successStatus === '204' ? {} : { content: emptyContent(successTypes) }),
  })

  // 2. Declared response schemas.
  for (const [status, authored] of Object.entries(route.schema?.response ?? {})) {
    const key = normalizeStatus(status)
    const schema = registry.register(authored, 'output', `${context} response.${status}`)
    const existing = responses.get(key)

    responses.set(key, {
      description: existing?.description ?? REASONS[key] ?? 'Response',
      ...(existing?.headers === undefined ? {} : { headers: existing.headers }),
      ...(key === '204'
        ? {}
        : {
            content: Object.fromEntries(
              contentTypesFor(key, successStatus, successTypes).map(type => [type, { schema }]),
            ),
          }),
    })
  }

  // 3. Inferred, never overwriting anything declared.
  if (options.infer.validation && hasRequestSchema(route)) {
    addInferred(responses, String(options.errors.validation), options, registry, context)
  }

  if (options.infer.auth && route.authorization.hasProtection) {
    addInferred(responses, String(options.errors.unauthorized), options, registry, context)
    addInferred(responses, String(options.errors.forbidden), options, registry, context)
  }

  // 4. Authored detail, merged over everything. Controller-wide first, then the operation's own.
  applyDetail(responses, groupResponses)
  applyDetail(responses, operationResponses)

  return Object.fromEntries([...responses].sort(byStatus))
}

function addInferred(
  responses: Map<string, ResponseObject>,
  status: string,
  options: OpenAPIOptions,
  registry: ComponentRegistry,
  context: string,
): void {
  if (responses.has(status)) {
    return
  }

  const schema =
    options.errorSchema === undefined
      ? undefined
      : registry.register(options.errorSchema, 'output', `${context} response.${status}`)

  responses.set(status, {
    description: REASONS[status] ?? 'Error',
    content: { 'application/json': schema === undefined ? {} : { schema } },
  })
}

function applyDetail(
  responses: Map<string, ResponseObject>,
  detail: Record<number | string, ResponseDetail> | undefined,
): void {
  for (const [status, authored] of Object.entries(detail ?? {})) {
    const key = normalizeStatus(status)
    const existing = responses.get(key)

    responses.set(key, {
      ...existing,
      ...authored,
      description: authored.description ?? existing?.description ?? REASONS[key] ?? 'Response',
      ...(authored.content === undefined
        ? existing?.content === undefined
          ? {}
          : { content: existing.content }
        : { content: { ...existing?.content, ...authored.content } }),
    })
  }
}

/**
 * The media types a response body is served as.
 *
 * An error response does not inherit the success types: a route producing `text/csv` still reports failures
 * as JSON — the error handler renders a body, not the resource — so carrying the success type onto a 4xx
 * would describe a CSV error document that never exists.
 */
function contentTypesFor(status: string, successStatus: string, successTypes: string[]): string[] {
  if (status === successStatus || status.startsWith('2')) {
    return successTypes
  }

  return ['application/json']
}

/**
 * The media types a route produces: everything `@Produces` declared, else JSON.
 *
 * `Route.contentType` is a single value today, so this is a list of one until the router carries more — but
 * the response shape is built from a list so that adding it later is not a rewrite.
 */
function responseMediaTypes(route: Route<unknown>): string[] {
  return route.contentType !== '' ? [route.contentType] : ['application/json']
}

function emptyContent(types: string[]): Record<string, Record<string, never>> {
  return Object.fromEntries(types.map(type => [type, {}]))
}

/**
 * Response headers the route already declares through `@Header`.
 *
 * The router has carried these all along and the document dropped them, so a route that promises a
 * `cache-control` or an `x-request-id` documented nothing about it. The value is not published — a header's
 * value is a runtime detail — only that the response carries it.
 */
function deriveHeaders(route: Route<unknown>): Record<string, HeaderObject> | undefined {
  if (route.header === undefined || route.header.size === 0) {
    return undefined
  }

  const headers: Record<string, HeaderObject> = {}
  for (const name of route.header.keys()) {
    // `content-type` is expressed by the content map itself; the specification says to ignore it here.
    if (name.toLowerCase() === 'content-type') {
      continue
    }
    headers[name] = { schema: { type: 'string' } }
  }

  return Object.keys(headers).length === 0 ? undefined : headers
}

/** Fastify accepts `4xx`; the specification writes it `4XX`. */
function normalizeStatus(status: string): string {
  return /^[1-5]xx$/i.test(status) ? status.toUpperCase() : status
}

function hasRequestSchema(route: Route<unknown>): boolean {
  const schema = route.schema
  if (schema === undefined) {
    return false
  }

  return (
    schema.params !== undefined ||
    schema.querystring !== undefined ||
    schema.headers !== undefined ||
    schema.body !== undefined
  )
}

// Numeric statuses ascending, then the wildcard ranges, then `default` — the order a reader expects.
function byStatus([a]: [string, ResponseObject], [b]: [string, ResponseObject]): number {
  const rank = (status: string) => (status === 'default' ? 2 : /^\d+$/.test(status) ? 0 : 1)
  const diff = rank(a) - rank(b)

  return diff !== 0 ? diff : a.localeCompare(b, undefined, { numeric: true })
}
