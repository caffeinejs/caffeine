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
