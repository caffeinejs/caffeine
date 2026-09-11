import { token } from '@caffeinejs/di'

import type { ResolvedStatic } from './static.js'

/**
 * What the feature actually serves, after the mounts and the SPA options were folded together.
 *
 * Read with `container.getOptional(kStaticOptions)`. Absent when the feature is not installed.
 */
export const kStaticOptions = token<ResolvedStatic>(Symbol('caffeine.static.options'))
