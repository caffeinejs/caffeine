import type { AuthSchemeDescriptor, Route } from '@caffeinejs/http'
import type { OpenAPIOptions } from '../options.js'
import type { SecurityRequirementObject, SecuritySchemeObject } from '../spec/spec.js'

/**
 * Turns the application's registered authentication schemes into `components.securitySchemes`.
 *
 * The descriptors come from http's authentication builder, which records how each scheme expects credentials
 * at the moment it constructs the handler. Nothing here restates configuration: the `.authentication(...)`
 * call that registers a scheme is its single declaration, where NestJS wants the same scheme described a
 * second time in its `DocumentBuilder`.
 *
 * Explicit `.securityScheme(...)` declarations are merged last, so a user can always override or add one the
 * framework cannot describe — notably a scheme registered through the bare `addStrategy`, which carries no
 * descriptor because nothing can interrogate an arbitrary handler.
 */
export function buildSecuritySchemes(
  descriptors: Map<string, AuthSchemeDescriptor> | undefined,
  options: OpenAPIOptions,
): Record<string, SecuritySchemeObject> | undefined {
  const schemes: Record<string, SecuritySchemeObject> = {}

  if (options.deriveSecuritySchemes && descriptors !== undefined) {
    for (const [name, descriptor] of descriptors) {
      const scheme = toSecurityScheme(descriptor)
      if (scheme !== undefined) {
        schemes[name] = scheme
      }
    }
  }

  Object.assign(schemes, options.securitySchemes)

  return Object.keys(schemes).length === 0 ? undefined : schemes
}

/** Maps one vendor-neutral descriptor onto its OpenAPI security scheme. */
export function toSecurityScheme(descriptor: AuthSchemeDescriptor): SecuritySchemeObject | undefined {
  const description = descriptor.description

  switch (descriptor.kind) {
    case 'http':
      return {
        type: 'http',
        scheme: descriptor.scheme ?? 'bearer',
        ...(descriptor.bearerFormat === undefined ? {} : { bearerFormat: descriptor.bearerFormat }),
        ...(description === undefined ? {} : { description }),
      }

    case 'apiKey': {
      // Without a location and a name there is nothing for a consumer to send, so an incomplete descriptor is
      // dropped rather than emitted as an unusable scheme.
      if (descriptor.in === undefined || descriptor.name === undefined) {
        return undefined
      }

      // An API key obtained through a sign-in — every OAuth-family strategy's session cookie — carries the
      // flow that issues it. OpenAPI has nowhere structured to put that on an `apiKey` scheme, and dropping
      // it would leave a reader holding a cookie name and no way to obtain one, so it becomes prose.
      const note = description ?? obtainedBy(descriptor)

      return {
        type: 'apiKey',
        in: descriptor.in,
        name: descriptor.name,
        ...(note === undefined ? {} : { description: note }),
      }
    }

    case 'openIdConnect':
      if (descriptor.openIdConnectURL === undefined) {
        return undefined
      }
      return {
        type: 'openIdConnect',
        openIdConnectUrl: descriptor.openIdConnectURL,
        ...(description === undefined ? {} : { description }),
      }

    case 'oauth2': {
      const flow = descriptor.flows?.authorizationCode
      if (flow === undefined) {
        return undefined
      }
      return {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: flow.authorizationURL,
            tokenUrl: flow.tokenURL,
            ...(flow.refreshURL === undefined ? {} : { refreshUrl: flow.refreshURL }),
            scopes: Object.fromEntries((flow.scopes ?? []).map(scope => [scope, ''])),
          },
        },
        ...(description === undefined ? {} : { description }),
      }
    }
  }
}

/**
 * How a credential is obtained, as a sentence, or nothing when the descriptor does not say.
 *
 * Only reached for a scheme whose transport cannot express the sign-in structurally — in practice the session
 * cookie every OAuth-family strategy writes. The sign-in is a browser round trip, so the sentence names where
 * it starts rather than pretending an API client can perform it.
 */
function obtainedBy(descriptor: AuthSchemeDescriptor): string | undefined {
  if (descriptor.openIdConnectURL !== undefined) {
    return `Session cookie issued after an OpenID Connect sign-in against ${descriptor.openIdConnectURL}. `
      + 'Sign in through the browser; the cookie is then sent automatically.'
  }

  const flow = descriptor.flows?.authorizationCode
  if (flow === undefined) {
    return undefined
  }

  const scopes = flow.scopes?.length ? ` (scopes: ${flow.scopes.join(', ')})` : ''

  return `Session cookie issued after an OAuth 2.0 sign-in at ${flow.authorizationURL}${scopes}. `
    + 'Sign in through the browser; the cookie is then sent automatically.'
}

/**
 * The security requirement for one operation, or `undefined` to inherit the document's.
 *
 * `@AllowAnonymous` produces an empty array, which is the specification's way of saying "no security" and the
 * only way to opt a single route out of a document-level requirement. Everything else comes from what
 * `@Authorize` / `@Roles` already stated, so a guarded route is documented as guarded without anyone
 * repeating themselves — NestJS needs `@ApiBearerAuth()` on every one.
 */
export function deriveSecurity(
  route: Route<unknown>,
  schemes: Record<string, SecuritySchemeObject> | undefined,
  defaultSchemeName: string | undefined,
): SecurityRequirementObject[] | undefined {
  const authz = route.authorization

  if (authz.options?.allowAnonymous === true) {
    return []
  }

  if (!authz.hasProtection) {
    return undefined
  }

  const requested = authz.options?.schemes?.length
    ? authz.options.schemes
    : defaultSchemeName === undefined ? [] : [defaultSchemeName]

  // A requirement may only name a scheme that `components.securitySchemes` defines, so anything undescribable
  // is dropped here rather than emitted as a dangling reference.
  //
  // The common case is a Forward strategy: `.forward('scheme', ...)` picks between real schemes per request
  // and is itself registered through the bare `addStrategy`, so nothing can describe it. When the route's
  // resolved scheme turns out to be one of those, every described scheme becomes an alternative — which is
  // what a forward actually means, and what OpenAPI's array-of-requirements already spells as "any of these".
  const defined = new Set(Object.keys(schemes ?? {}))
  const names = requested.filter(name => defined.has(name))
  const resolved = names.length > 0 ? names : requested.length > 0 ? [...defined] : []

  if (resolved.length === 0) {
    return undefined
  }

  // Roles become scopes only where the scheme has a scope concept. On an http or apiKey scheme a scope list
  // is meaningless — the specification requires it to be empty — so the roles are dropped here and remain
  // visible in the operation's description instead.
  const roles = authz.options?.roles ?? []

  return resolved.map(name => ({ [name]: scopesFor(schemes?.[name], roles) }))
}

function scopesFor(scheme: SecuritySchemeObject | undefined, roles: string[]): string[] {
  if (scheme === undefined) {
    return []
  }

  return scheme.type === 'oauth2' || scheme.type === 'openIdConnect' ? roles : []
}

/**
 * A human-readable note about what a route requires beyond authentication, appended to its description.
 *
 * Roles and policies have no OpenAPI representation on most scheme types, and silently dropping them would
 * describe a route as merely "authenticated" when it is not.
 */
export function authorizationNote(route: Route<unknown>): string | undefined {
  const options = route.authorization.options
  if (options === undefined || options.allowAnonymous === true) {
    return undefined
  }

  const parts: string[] = []

  if (options.roles?.length) {
    parts.push(`roles: ${options.roles.join(', ')}`)
  }

  const policies = options.policy === undefined
    ? []
    : Array.isArray(options.policy) ? options.policy : [options.policy]
  if (policies.length > 0) {
    parts.push(`policy: ${policies.join(', ')}`)
  }

  return parts.length === 0 ? undefined : `Requires ${parts.join('; ')}.`
}
