import { type AuthSchemeDescriptor, type Route, type RouteGroup, solutions } from '@caffeinejs/http'

import type { APIGroupDetail, OperationDetail } from '../decorators/detail.js'
import { kAPIGroup, kOperation } from '../decorators/keys.js'
import { ErrOpenAPIConfiguration, ErrOpenAPIOperationConflict } from '../errors.js'
import type { OpenAPIOptions } from '../options.js'
import type {
  ComponentsObject,
  HTTPMethod,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  TagObject,
} from '../spec/spec.js'
import { ComponentRegistry } from './components.js'
import { defaultOperationId, operationSite, routerBaseName } from './naming.js'
import { deriveParameters } from './parameters.js'
import { routeURL, translatePath } from './paths.js'
import { deriveRequestBody } from './request_body.js'
import { deriveResponses } from './responses.js'
import { authorizationNote, buildSecuritySchemes, deriveSecurity } from './security.js'

/** The eight methods a 3.1 PathItem can hold. Anything else needs 3.2's `additionalOperations`. */
const FIXED_METHODS = new Set<string>(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

export interface GenerateInput {
  routeGroups: Array<RouteGroup<unknown>>
  options: OpenAPIOptions
  /** How each registered authentication scheme expects credentials, when the application configured any. */
  schemes?: Map<string, AuthSchemeDescriptor>
  /** Collects non-fatal problems — a route the target version cannot represent, for instance. */
  onWarning?: (message: string) => void
}

/**
 * Builds the OpenAPI document from the routes the application already declared.
 *
 * Pure: no Fastify, no container, no I/O. That keeps it testable against hand-built `RouteGroup[]` fixtures and
 * leaves the door open for a CLI that emits the document without starting a server.
 *
 * `routeGroups` never includes the package's own document-serving routes: they are compiled and registered
 * through `instance.$route(...)` after `$routeGroups` (this function's input) is already fixed, so there is
 * nothing here to exclude them from — no `exposeSelf` switch, because there is no state it could switch.
 */
export function generateDocument(input: GenerateInput): OpenAPIDocument {
  const { options } = input
  const warn = input.onWarning ?? (() => undefined)
  const registry = new ComponentRegistry(options.dedupeComponents, options.schemaName)
  const securitySchemes = buildSecuritySchemes(input.schemes, options)

  const paths: Record<string, PathItemObject> = {}
  const tags = new Map<string, TagObject>(options.tags.map(tag => [tag.name, tag]))
  const operationIds = new Map<string, string>()

  for (const router of input.routeGroups) {
    const group = router.extras?.get(kAPIGroup) as APIGroupDetail | undefined
    if (group?.hidden === true) {
      continue
    }

    const tagName = options.tagFor?.(router) ?? group?.name ?? routerBaseName(router)
    if (group !== undefined && !tags.has(tagName)) {
      tags.set(tagName, tagObject(tagName, group, options))
    }

    for (const route of router.routes) {
      const detail = route.extras?.get(kOperation) as OperationDetail | undefined
      if (detail?.hidden === true) {
        continue
      }

      addRoute({ router, route, group, detail, tagName, paths, registry, operationIds, securitySchemes, input, warn })
    }
  }

  const schemas = registry.build()
  // Raw components merged last, so an application can supply the parts the generator never produces
  // (responses, parameters, examples) and override a generated one where it needs to.
  const components = mergeComponents(schemas, securitySchemes, options.components)

  return {
    openapi: options.version,
    info: options.info,
    ...(options.servers.length > 0 ? { servers: options.servers } : {}),
    ...(options.security === undefined ? {} : { security: options.security }),
    paths,
    ...(components === undefined ? {} : { components }),
    ...(tags.size > 0 ? { tags: [...tags.values()] } : {}),
    ...(options.externalDocs === undefined ? {} : { externalDocs: options.externalDocs }),
  }
}

interface AddRouteInput {
  router: RouteGroup<unknown>
  route: Route<unknown>
  group: APIGroupDetail | undefined
  detail: OperationDetail | undefined
  tagName: string
  paths: Record<string, PathItemObject>
  registry: ComponentRegistry
  operationIds: Map<string, string>
  securitySchemes: Record<string, SecuritySchemeObject> | undefined
  input: GenerateInput
  warn: (message: string) => void
}

function addRoute(ctx: AddRouteInput): void {
  const { router, route, group, detail, input, warn } = ctx
  const { options } = input

  const url = routeURL(router.prefix, router.path, route.path)
  const { templates, parameters: pathParams } = translatePath(url)
  const site = operationSite(router, route)

  const operationId = detail?.operationId ?? options.operationId?.(router, route) ?? defaultOperationId(router, route)

  const existing = ctx.operationIds.get(operationId)
  if (existing !== undefined) {
    throw new ErrOpenAPIOperationConflict(operationId, existing, site)
  }
  ctx.operationIds.set(operationId, site)

  const context = `${route.method[0] ?? 'GET'} ${url}`
  const derivedParameters = deriveParameters(route, pathParams, ctx.registry, context)

  const operation: OperationObject = {
    operationId,
    tags: detail?.tags ?? [ctx.tagName],
    ...(detail?.summary === undefined ? {} : { summary: detail.summary }),
    ...(describe(detail, route) === undefined ? {} : { description: describe(detail, route) }),
    ...(detail?.externalDocs === undefined ? {} : { externalDocs: detail.externalDocs }),
    ...((detail?.deprecated ?? group?.deprecated) ? { deprecated: true } : {}),
    ...(derivedParameters.length > 0 || detail?.parameters !== undefined
      ? { parameters: mergeParameters(derivedParameters, detail?.parameters) }
      : {}),
    responses: deriveResponses(route, options, ctx.registry, context, group?.responses, detail?.responses),
    ...extensionsOf(detail),
  }

  const requestBody = deriveRequestBody(route, ctx.registry, context)
  if (requestBody !== undefined) {
    operation.requestBody =
      detail?.requestBody === undefined
        ? requestBody
        : { ...requestBody, ...detail.requestBody, content: { ...requestBody.content, ...detail.requestBody.content } }
  }

  const security = detail?.security ?? deriveSecurity(route, ctx.securitySchemes) ?? group?.security
  if (security !== undefined) {
    operation.security = security
  }

  const servers = detail?.servers ?? group?.servers
  if (servers !== undefined) {
    operation.servers = servers
  }

  for (const template of templates) {
    const item = (ctx.paths[template] ??= {})

    for (const method of route.method) {
      const lower = method.toLowerCase()

      if (FIXED_METHODS.has(lower)) {
        item[lower as HTTPMethod] = operation
        continue
      }

      // 3.1's PathItem has only the eight fixed verb fields, so there is nowhere legal to put a QUERY (or
      // LOCK, or REPORT) operation. Emitting it anyway would produce a document that fails validation, and
      // silently dropping it would be worse — so it is dropped loudly.
      if (options.version === '3.1.1') {
        warn(
          `Route "${method} ${url}" (${site}) is omitted from the OpenAPI document: ` +
            `OpenAPI 3.1.1 cannot represent the "${method}" method` +
            solutions(
              'Set .version("3.2.0") on the OpenAPI builder, which represents it via additionalOperations',
              'Hide the route with @Operation({ hidden: true }) to omit it deliberately',
            ),
        )
        continue
      }

      item.additionalOperations ??= {}
      item.additionalOperations[method.toUpperCase()] = operation
    }
  }
}

/** The operation's description, with the authorization note appended when the route requires more than auth. */
function describe(detail: OperationDetail | undefined, route: Route<unknown>): string | undefined {
  const note = authorizationNote(route)
  const described = detail?.description

  if (described === undefined) {
    return note
  }

  return note === undefined ? described : `${described}\n\n${note}`
}

/** Authored parameters are merged over derived ones by `(name, in)`, never appended blindly. */
function mergeParameters(derived: ParameterObject[], authored: OperationDetail['parameters']): ParameterObject[] {
  if (authored === undefined) {
    return derived
  }

  const merged = new Map(derived.map(p => [`${p.in}:${p.name}`, p]))

  for (const parameter of authored) {
    const id = `${parameter.in}:${parameter.name}`
    const existing = merged.get(id)
    merged.set(id, { ...existing, ...parameter } as ParameterObject)
  }

  return [...merged.values()]
}

function tagObject(name: string, group: APIGroupDetail, options: OpenAPIOptions): TagObject {
  return {
    name,
    ...(group.description === undefined ? {} : { description: group.description }),
    // `summary` on a tag arrived in 3.2; emitting it under 3.1 makes the document invalid.
    ...(group.summary === undefined || options.version === '3.1.1' ? {} : { summary: group.summary }),
    ...(group.externalDocs === undefined ? {} : { externalDocs: group.externalDocs }),
    ...extensionsOf(group),
  }
}

/** Copies the `x-` prefixed keys off an authored detail object. */
function extensionsOf(detail: object | undefined): Record<string, unknown> {
  if (detail === undefined) {
    return {}
  }

  return Object.fromEntries(Object.entries(detail).filter(([key]) => key.startsWith('x-')))
}

/**
 * Rejects a configuration that cannot produce a valid document, before the server starts listening.
 *
 * Only checks that survive to the finished document belong here — a template placeholder with no Parameter
 * Object makes the document invalid, and finding that out from a consumer's validator later is strictly worse
 * than finding it out at boot.
 */
export function validateDocument(document: OpenAPIDocument): void {
  const definedSchemes = new Set(Object.keys(document.components?.securitySchemes ?? {}))

  const assertSchemes = (requirements: SecurityRequirementObject[] | undefined, where: string): void => {
    for (const requirement of requirements ?? []) {
      for (const name of Object.keys(requirement)) {
        if (!definedSchemes.has(name)) {
          throw new ErrOpenAPIConfiguration(
            `Cannot generate OpenAPI document: ${where} requires the security scheme "${name}", ` +
              'which components.securitySchemes does not define' +
              solutions(
                `Declare it with .securityScheme("${name}", { ... }) on the OpenAPI builder`,
                'Register it through .authentication(...) so it can be described automatically',
              ),
          )
        }
      }
    }
  }

  assertSchemes(document.security, 'the document')

  for (const [template, item] of Object.entries(document.paths ?? {})) {
    const declared = new Set<string>()
    const operations = [
      ...Object.entries(item)
        .filter(([key]) => FIXED_METHODS.has(key))
        .map(([, op]) => op as OperationObject),
      ...Object.values(item.additionalOperations ?? {}),
    ]

    for (const operation of operations) {
      assertSchemes(operation.security, `operation "${operation.operationId ?? template}"`)

      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'path') {
          declared.add(parameter.name)
        }
      }
    }

    for (const [, name] of template.matchAll(/\{([^}]+)\}/g)) {
      if (operations.length > 0 && !declared.has(name)) {
        throw new ErrOpenAPIConfiguration(
          `Cannot generate OpenAPI document: path "${template}" declares no parameter for "{${name}}"` +
            solutions(
              `Add "${name}" to the route's @Schema({ params }) so it is described`,
              `Add it via @Operation({ parameters: [{ name: "${name}", in: "path" }] })`,
            ),
        )
      }
    }
  }
}

/** Combines the generated components with any the application supplied. Supplied entries win. */
function mergeComponents(
  schemas: Record<string, SchemaObject> | undefined,
  securitySchemes: Record<string, SecuritySchemeObject> | undefined,
  extra: ComponentsObject | undefined,
): ComponentsObject | undefined {
  const components: ComponentsObject = {
    ...(schemas === undefined ? {} : { schemas }),
    ...(securitySchemes === undefined ? {} : { securitySchemes }),
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    const existing = components[key as keyof ComponentsObject]
    components[key as keyof ComponentsObject] =
      isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value
  }

  return Object.keys(components).length === 0 ? undefined : components
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
