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
export function routeRecordsOf(container: Container, registered: readonly RegisteredRoute[]): RouteRecord[] {
  const fallback = fallbackFor(container)
  const gates = container.getOptional(AuthenticationGates)?.installed ?? []
  const defaultScheme = container.getOptional(AuthenticationSchemeProvider)?.defaultAuthenticateScheme
  const records: RouteRecord[] = []
  // The record a handler registered under a path, so its HEAD twin joins it.
  const byHandler = new Map<unknown, Map<string, { methods: string[] }>>()

  for (const { route, url, method, context } of registered) {
    const methods = [method].flat()
    const twin = methods.length === 1 && methods[0] === 'HEAD' ? byHandler.get(route.handler)?.get(url) : undefined

    if (twin !== undefined) {
      twin.methods.push('HEAD')
      continue
    }

    const meta = route.config?.$caffeine
    const compiled = meta?.compiled
    const authz = compiled?.route.authorization
    const gated = meta?.auth ?? fallback?.forPath(url)
    // A compiled route that declared nothing had the fallback policy compiled in; a raw one is handed it per path.
    const usesFallback =
      authz === undefined ? meta?.auth === undefined && gated !== undefined : authz.options === undefined
    const covering = gateCovering(gates, context, meta?.gateOwner)
    const skipped = meta?.skipAuthentication === true
    const declared = compiled?.route.authorization.schemes ?? meta?.auth?.schemes ?? []
    // A raw route that named no scheme is authenticated by the default one, as a compiled route's already says.
    const schemes = skipped ? [] : declared.length > 0 || defaultScheme === undefined ? [...declared] : [defaultScheme]

    const security: RouteSecurityRecord = {
      authentication: {
        skipped,
        schemes,
        allowAnonymous: gated?.allowAnonymous === true,
        gate: covering?.label,
      },
      authorization: {
        protected: !skipped && gated?.allowAnonymous !== true && gated?.authorizer != null,
        fallback: usesFallback && gated?.authorizer != null,
        policies: [...(authz?.options?.policies ?? [])],
        roleGroups: (authz?.options?.roleGroups ?? []).map(roles => [...roles]),
        defaultPolicy: authz?.options?.defaultPolicy === true,
      },
      guards: (compiled?.route.guards ?? []).map(guard => guard.name),
      csrf: csrfOf(methods, url, route.config, context),
    }

    const schema = route.schema ?? {}
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
      schema: {
        params: schema.params !== undefined,
        querystring: schema.querystring !== undefined,
        headers: schema.headers !== undefined,
        body: schema.body !== undefined,
        response: schema.response !== undefined,
      },
      security,
    } satisfies RouteRecord

    records.push(record)

    const paths = byHandler.get(route.handler) ?? new Map<string, { methods: string[] }>()
    paths.set(url, record)
    byHandler.set(route.handler, paths)
  }

  return records
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
