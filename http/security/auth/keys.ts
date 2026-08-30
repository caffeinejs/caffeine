import { token } from '@caffeinejs/di'
import type { AuthenticationOptions } from './builder.js'
import type { AuthSchemeDescriptor } from './descriptor.js'
import type { OIDCMeta } from './oidc/index.js'

export const kAuthOpts = token<AuthenticationOptions>(Symbol('caffeinejs.authentication.options'))
export const kOIDCMeta = token<OIDCMeta>(Symbol('caffeinejs.oidc.meta'))

/**
 * DI key for the `Map<string, AuthSchemeDescriptor>` describing how each registered scheme expects credentials.
 * Bound by the authentication builder, so it is absent when the application configured no authentication. A scheme
 * added through `addStrategy` has no entry: only the `addX` methods know enough to describe one.
 */
export const kAuthSchemeDescriptors = token<Map<string, AuthSchemeDescriptor>>(
  Symbol('caffeinejs.authentication.scheme_descriptors'),
)
