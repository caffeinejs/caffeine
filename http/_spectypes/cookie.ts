import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { CookieOptions } from '../cookie/cookie.js'

/**
 * The schema of the cookie configuration block, satisfying {@link CookieOptions}. Hand the node to
 * `.cookie((k, { config }) => k.config(...))`.
 *
 * `secret` takes a list too, which rotates secrets. `parseOptions` is not part of it: `encode` and `decode` are
 * functions, which no configuration source can carry, so those defaults are set with `parseOptions(...)`.
 */
export const CookieConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  secret: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
  algorithm: $t.Optional($t.UnionEnum(['SHA-256', 'SHA-384', 'SHA-512'])),
})

type _Satisfies = SchemaSatisfies<CookieOptions, InferConfig<typeof CookieConfigSchema>>
