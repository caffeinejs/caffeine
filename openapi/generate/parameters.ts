import type { Route } from '@caffeinejs/http'
import type { AnySchema } from '@caffeinejs/std'

import type { ParameterLocation, ParameterObject, SchemaObject } from '../spec/spec.js'
import type { ComponentRegistry } from './components.js'
import type { PathParameter } from './paths.js'

/** Maps a `RouteValidationSchema` slot to where its properties travel. */
const SLOTS: Array<[slot: 'params' | 'querystring' | 'headers', location: ParameterLocation]> = [
  ['params', 'path'],
  ['querystring', 'query'],
  ['headers', 'header'],
]

/**
 * Headers that describe a credential rather than an input.
 *
 * The specification says these must not be documented as parameters — `securitySchemes` describes them, and a
 * consumer that saw both would render a redundant field next to its own auth control.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie'])

/**
 * Derives an operation's parameters.
 *
 * The authored `@Schema` slots are the real source: each is an object schema, so every property is one
 * parameter and the object's `required[]` says which are mandatory. Where a slot has no schema the `$p`
 * pickers still name what the handler reads, which is enough for a correct — if untyped — parameter. Finally
 * any `{name}` left in the path template gets a parameter regardless, because a template placeholder with no
 * Parameter Object makes the document invalid.
 */
export function deriveParameters(
  route: Route<unknown>,
  pathParams: PathParameter[],
  registry: ComponentRegistry,
  context: string,
): ParameterObject[] {
  const found = new Map<string, ParameterObject>()
  const key = (name: string, location: ParameterLocation) => `${location}:${name}`

  for (const [slot, location] of SLOTS) {
    const authored = route.schema?.[slot]
    if (authored === undefined) {
      continue
    }

    for (const parameter of fromObjectSchema(authored, location, registry, `${context} ${slot}`)) {
      found.set(key(parameter.name, parameter.in), parameter)
    }
  }

  for (const picked of fromPickers(route)) {
    const id = key(picked.name, picked.in)
    if (!found.has(id)) {
      found.set(id, picked)
    }
  }

  for (const header of fromConstraints(route)) {
    const id = key(header.name, 'header')
    if (!found.has(id)) {
      found.set(id, header)
    }
  }

  // The template is the last word on path parameters: one without a Parameter Object is a spec violation, and
  // a schema that declared a path property the template does not carry is not a path parameter at all.
  const inTemplate = new Set(pathParams.map(p => p.name))
  for (const param of pathParams) {
    const id = key(param.name, 'path')
    const existing = found.get(id)

    found.set(id, {
      ...(existing ?? { name: param.name, in: 'path', schema: { type: 'string' } }),
      name: param.name,
      in: 'path',
      required: true,
      ...(param.pattern === undefined ? {} : { schema: withPattern(existing?.schema, param.pattern) }),
      ...(param.wildcard === true
        ? { description: existing?.description ?? 'Matches the remainder of the path', 'x-caffeine-wildcard': true }
        : {}),
    })
  }

  for (const [id, parameter] of [...found]) {
    if (parameter.in === 'path' && !inTemplate.has(parameter.name)) {
      found.delete(id)
    }
  }

  return [...found.values()]
}

/** Explodes one object schema into a parameter per property. */
function fromObjectSchema(
  authored: AnySchema,
  location: ParameterLocation,
  registry: ComponentRegistry,
  context: string,
): ParameterObject[] {
  // Registered rather than converted directly so a `$id` on the slot still reaches components — but the
  // properties themselves are what becomes parameters, so a slot that resolved to a bare `$ref` has nothing
  // to explode and is skipped.
  const schema = registry.register(authored, 'input', context)
  const properties = schema.properties

  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return []
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])

  return Object.entries(properties as Record<string, unknown>)
    .filter(([name]) => !(location === 'header' && CREDENTIAL_HEADERS.has(name.toLowerCase())))
    .map(([name, value]) => {
      const property = (typeof value === 'object' && value !== null ? value : {}) as SchemaObject
      const { description, deprecated, ...rest } = property

      return {
        name,
        in: location,
        // A path parameter is required by definition; elsewhere the object's `required` list decides.
        required: location === 'path' ? true : required.has(name),
        ...(typeof description === 'string' ? { description } : {}),
        ...(deprecated === true ? { deprecated: true } : {}),
        schema: rest,
      } satisfies ParameterObject
    })
}

/**
 * Falls back to the `$p` pickers when a slot has no schema.
 *
 * A picker names what the handler actually reads, so `$p.param('id')` is proof a path parameter exists even
 * though nobody wrote a schema for it. Only the named pickers are usable: `$p.query()` with no name hands the
 * handler the whole query object and says nothing about its shape.
 */
function fromPickers(route: Route<unknown>): ParameterObject[] {
  const parameters: ParameterObject[] = []

  for (const picker of route.parameters) {
    const location = PICKER_LOCATIONS[picker.type]
    if (location === undefined || picker.name === undefined) {
      continue
    }

    if (location === 'header' && CREDENTIAL_HEADERS.has(picker.name.toLowerCase())) {
      continue
    }

    parameters.push({
      name: picker.name,
      in: location,
      required: location === 'path',
      schema: { type: 'string' },
    })
  }

  return parameters
}

/**
 * A required header parameter for each route-selection constraint that reads one — `Accept-Version` on a
 * versioned route. The value the route requires is not the request's, so the schema stays an open string.
 */
function fromConstraints(route: Route<unknown>): ParameterObject[] {
  if (route.constraints === undefined) {
    return []
  }

  const parameters: ParameterObject[] = []
  for (const resolved of route.constraints.values()) {
    if (resolved.header === undefined || CREDENTIAL_HEADERS.has(resolved.header.toLowerCase())) {
      continue
    }

    parameters.push({ name: resolved.header, in: 'header', required: true, schema: { type: 'string' } })
  }

  return parameters
}

const PICKER_LOCATIONS: Record<string, ParameterLocation | undefined> = {
  params: 'path',
  query: 'query',
  header: 'header',
  cookie: 'cookie',
  'cookie:signed': 'cookie',
}

function withPattern(schema: SchemaObject | undefined, pattern: string): SchemaObject {
  return { type: 'string', ...schema, pattern }
}
