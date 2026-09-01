import { token } from '@caffeinejs/di'
import { contributionKey } from '@caffeinejs/std'
import type { AuthenticationOptions } from './builder.js'
import type { AuthSchemeDescriptor } from './descriptor.js'
import type { OIDCMeta } from './oidc/index.js'

/** The resolved {@link AuthenticationOptions}, absent when the application configured no authentication. */
export const kAuthContribution = contributionKey<AuthenticationOptions>('http:auth.options')

/** The OIDC handlers and their reachability, absent unless an OIDC strategy was registered. */
export const kOIDCContribution = contributionKey<OIDCMeta>('http:auth.oidc')

/**
 * DI key for the `Map<string, AuthSchemeDescriptor>` describing how each registered scheme expects credentials.
 * Bound by the authentication builder, so it is absent when the application configured no authentication. A scheme
 * added through `addStrategy` has no entry: only the `addX` methods know enough to describe one.
 */
export const kAuthSchemeDescriptors = token<Map<string, AuthSchemeDescriptor>>(
  Symbol('caffeinejs.authentication.scheme_descriptors'),
)
