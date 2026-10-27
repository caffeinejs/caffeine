import type { Container } from '@caffeinejs/di'

import { isExcluded } from '../../../core/csrf/options.js'
import { SAFE_METHODS } from '../../../core/csrf/origin.js'
import { csrfMarkOf } from '../../../core/csrf/route.js'
import type { RouteRecord, RouteSecurityRecord } from '../../../core/routing/inventory.js'
import { AuthenticationGates } from '../../../core/security/auth/gates.js'
import { AuthenticationSchemeProvider } from '../../../core/security/auth/scheme_provider.js'
import { csrfCovering } from '../csrf/csrf.js'
import { fallbackFor, gateCovering, type RegisteredRoute } from '../security/security.js'

/**
 * Describes every route a server registered, for the application's route inventory.
 *
 * Read once every route has registered, so what a later `onRoute` hook stamped (a gate's ownership, an exemption) is
 * in. A GET route's automatic HEAD twin, registered with the same handler under the same path, is folded into it.
 */
export function routeRecordsOf(container: Container, routes: readonly RegisteredRoute[]): RouteRecord[] {
  const scope: SecurityScope = {
    fallback: fallbackFor(container),
    gates: container.getOptional(AuthenticationGates)?.installed ?? [],
    defaultScheme: container.getOptional(AuthenticationSchemeProvider)?.defaultAuthenticateScheme,
  }
  const records: RouteRecord[] = []
  // The record a handler registered under a path, so its HEAD twin joins it.
  const byHandler = new Map<unknown, Map<string, { methods: string[] }>>()

  for (const registered of routes) {
    const { route, url, method } = registered
    const methods = [method].flat()
    const twin = methods.length === 1 && methods[0] === 'HEAD' ? byHandler.get(route.handler)?.get(url) : undefined

    if (twin !== undefined) {
      twin.methods.push('HEAD')
      continue
    }

    const compiled = route.config?.$caffeine?.compiled
    const record = {
      methods: [...methods],
      url,
      kind: compiled === undefined ? 'raw' : 'compiled',
      handler: compiled === undefined ? route.handler.name || undefined : String(compiled.route.name),
      group: compiled?.group.name,
      produces: compiled?.contentType || undefined,
      consumes: [...(compiled?.route.accept ?? [])],
      status: compiled?.hasStatus === true ? compiled.status : undefined,
      timeout: compiled?.route.timeout,
      bodyLimit: route.bodyLimit,
      schema: schemaOf(route.schema ?? {}),
      security: securityOf(scope, registered),
    } satisfies RouteRecord

    records.push(record)

    const paths = byHandler.get(route.handler) ?? new Map<string, { methods: string[] }>()
    paths.set(url, record)
    byHandler.set(route.handler, paths)
  }

  return records
}

/** What the server knows of every route's protection: the fallback policy, its gates and the default scheme. */
interface SecurityScope {
  readonly fallback: ReturnType<typeof fallbackFor>
  readonly gates: Parameters<typeof gateCovering>[0]
  readonly defaultScheme: string | undefined
}

function securityOf(scope: SecurityScope, { route, url, method, context }: RegisteredRoute): RouteSecurityRecord {
  const meta = route.config?.$caffeine
  const compiled = meta?.compiled
  const authz = compiled?.route.authorization
  const gated = meta?.auth ?? scope.fallback?.forPath(url)
  // A compiled route that declared nothing had the fallback policy compiled in; a raw one is handed it per path.
  const usesFallback =
    authz === undefined ? meta?.auth === undefined && gated !== undefined : authz.options === undefined
  const skipped = meta?.skipAuthentication === true

  return {
    authentication: {
      skipped,
      schemes: skipped ? [] : schemesOf(compiled?.route.authorization.schemes ?? meta?.auth?.schemes ?? [], scope),
      allowAnonymous: gated?.allowAnonymous === true,
      gate: gateCovering(scope.gates, context, meta?.gateOwner)?.label,
    },
    authorization: {
      protected: !skipped && gated?.allowAnonymous !== true && gated?.authorizer != null,
      fallback: usesFallback && gated?.authorizer != null,
      policies: [...(authz?.options?.policies ?? [])],
      roleGroups: (authz?.options?.roleGroups ?? []).map(roles => [...roles]),
      defaultPolicy: authz?.options?.defaultPolicy === true,
    },
    guards: (compiled?.route.guards ?? []).map(guard => guard.name),
    csrf: csrfOf([method].flat(), url, route.config, context),
  }
}

/** A raw route that named no scheme is authenticated by the default one, as a compiled route's already says. */
function schemesOf(declared: readonly string[], scope: SecurityScope): string[] {
  if (declared.length > 0 || scope.defaultScheme === undefined) {
    return [...declared]
  }

  return [scope.defaultScheme]
}

function schemaOf(schema: Partial<Record<keyof RouteRecord['schema'], unknown>>): RouteRecord['schema'] {
  return {
    params: schema.params !== undefined,
    querystring: schema.querystring !== undefined,
    headers: schema.headers !== undefined,
    body: schema.body !== undefined,
    response: schema.response !== undefined,
  }
}

function csrfOf(
  methods: readonly string[],
  url: string,
  config: unknown,
  context: object,
): RouteSecurityRecord['csrf'] {
  const mark = csrfMarkOf(config)

  if (mark === true) {
    return 'exempt'
  }

  if (methods.every(method => SAFE_METHODS.has(method))) {
    return 'safe'
  }

  const covers = csrfCovering(context)

  if (covers.length === 0) {
    return 'uncovered'
  }

  // A route's own `false` mark keeps it protected under an excluded prefix.
  if (mark === undefined && covers.every(exclude => isExcluded(url, exclude))) {
    return 'excluded'
  }

  return 'protected'
}
