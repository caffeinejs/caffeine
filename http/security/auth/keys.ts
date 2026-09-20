import { token } from '@caffeinejs/di'

import type { AuthSchemeDescriptor } from './descriptor.js'

/**
 * DI key for the `Map<string, AuthSchemeDescriptor>` describing how each registered scheme expects credentials.
 * Bound by the authentication builder, so it is absent when the application configured no authentication. A scheme
 * added through `addStrategy` has no entry: only the `addX` methods know enough to describe one.
 */
export const kAuthSchemeDescriptors = token<Map<string, AuthSchemeDescriptor>>(
  Symbol('caffeinejs.authentication.scheme_descriptors'),
)

/**
 * Fastify route-config marker: the authentication gate does not run for a route that carries it.
 *
 * For a route registered straight on the server that has to answer before anyone is signed in, whatever the
 * application's fallback policy says — a health probe, the callback an identity provider redirects to. A compiled
 * route never needs it: `@AllowAnonymous` says the same thing.
 *
 * ```ts
 * instance.get('/metrics', { config: { [kAuthenticationExempt]: true } }, handler)
 * ```
 *
 * No principal is established for such a route either, so its handler must not read `ctx.user`.
 */
export const kAuthenticationExempt: unique symbol = Symbol.for('@caffeinejs/http:authentication.exempt')
