import type { Route } from '@caffeinejs/http'
import { hasFileSchema } from '@caffeinejs/std/schema'
import type { RequestBodyObject, SchemaObject } from '../spec/spec.js'
import type { ComponentRegistry } from './components.js'

/** Methods that carry no request body, whatever else the route declares. */
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'TRACE'])

/** Pickers that mean the handler reads a multipart upload. */
const MULTIPART_PICKERS = new Set([
  'multipart:file',
  'multipart:files',
  'multipart:formdata',
  'multipart:streamfile',
  'multipart:streamfiles',
  'multipart:streamparts',
  'multipart:streamfile:web',
  'multipart:streamfiles:web',
  'multipart:streamparts:web',
])

/** Pickers naming a single file field, which is what lets the synthesized schema name its properties. */
const NAMED_FILE_PICKERS = new Set(['multipart:file', 'multipart:streamfile', 'multipart:streamfile:web'])

/**
 * Derives an operation's request body, or `undefined` when it has none.
 *
 * Two sources, in order: the authored `@Schema({ body })`, and — when there is no body schema but the handler
 * takes file pickers — a synthesized `multipart/form-data` schema built from the field names those pickers
 * ask for. The synthesis is the point: an upload route is fully described by `@Args([$p.file('file')])`.
 *
 * A body schema declaring `$t.File()` is the other way to write an upload, and the only one available to a
 * handler that takes no pickers: it is documented as `multipart/form-data` from the schema alone.
 */
export function deriveRequestBody(
  route: Route<unknown>,
  registry: ComponentRegistry,
  context: string,
): RequestBodyObject | undefined {
  if (route.method.every(method => BODYLESS.has(method.toUpperCase()))) {
    return undefined
  }

  const authored = route.schema?.body
  const multipart = route.parameters.some(picker => MULTIPART_PICKERS.has(picker.type)) || hasFileSchema(authored)

  if (authored !== undefined) {
    const schema = registry.register(authored, 'input', `${context} body`)
    const content: RequestBodyObject['content'] = {}
    for (const mediaType of requestMediaTypes(route, multipart)) {
      content[mediaType] = { schema }
    }
    return { required: true, content }
  }

  if (multipart) {
    return {
      required: true,
      content: { 'multipart/form-data': { schema: multipartSchema(route) } },
    }
  }

  // A `$p.body()` with no schema still proves a body exists; its shape is simply unknown.
  if (route.parameters.some(picker => picker.type === 'body')) {
    const content: RequestBodyObject['content'] = {}
    for (const mediaType of requestMediaTypes(route, false)) {
      content[mediaType] = {}
    }
    return { required: true, content }
  }

  return undefined
}

/**
 * The media types a request body may arrive as: everything `@Consumes` declared, else multipart when file
 * pickers or a file body schema say so, else JSON.
 *
 * All of them, not just the first — `@Consumes('application/json', 'application/xml')` means the route really
 * does accept both, and documenting one silently narrows the published contract.
 */
function requestMediaTypes(route: Route<unknown>, multipart: boolean): string[] {
  const declared = route.accept.filter(value => value !== '')
  if (declared.length > 0) {
    return [...new Set(declared)]
  }

  return [multipart ? 'multipart/form-data' : 'application/json']
}

/**
 * Builds the `multipart/form-data` schema from the file pickers a handler declares.
 *
 * `format: 'binary'` on a string is how OpenAPI spells a file upload, and it is what makes a consumer render
 * a file picker rather than a text box. An unnamed picker (`$p.files()`, `$p.formData()`) contributes an
 * open-ended object instead, because the handler reads whatever was sent and no field name is knowable.
 */
function multipartSchema(route: Route<unknown>): SchemaObject {
  const properties: Record<string, SchemaObject> = {}
  let open = false

  for (const picker of route.parameters) {
    if (!MULTIPART_PICKERS.has(picker.type)) {
      continue
    }

    if (NAMED_FILE_PICKERS.has(picker.type) && picker.name !== undefined) {
      properties[picker.name] = { type: 'string', format: 'binary' }
    } else {
      open = true
    }
  }

  const named = Object.keys(properties).length > 0

  if (!named) {
    return { type: 'object', additionalProperties: true }
  }

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    ...(open ? { additionalProperties: true } : {}),
  }
}
