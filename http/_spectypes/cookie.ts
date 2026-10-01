import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { CookieOptions } from '../cookie/cookie.js'

/**
 * The schema of the cookie configuration block, satisfying {@link CookieOptions}. Hand the node to
 * `.cookie((k, { config }) => k.config(...))`.
 *
 * `parseOptions` is not part of it: a serializer's `encode` is a function, which no configuration source can
 * carry, so those defaults are set with `parseOptions(...)`.
 */
export const CookieConfigSchema = $t.Object({
  enabled: $t.Boolean({ default: true }),
  secret: $t.Optional($t.String()),
})

type _Satisfies = SchemaSatisfies<CookieOptions, InferConfig<typeof CookieConfigSchema>>
