import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { DistLockConfig } from '../options.js'

/**
 * The schema of the distributed lock configuration block, satisfying {@link DistLockConfig}. Hand the node to
 * `DistributedLock((d, { config }) => d.config(...))`.
 *
 * Every member is optional and nothing is defaulted here: the feature owns its defaults. Give the block itself a
 * default so a deployment that tunes nothing still validates:
 *
 * ```ts
 * $t.Object({ distlock: $t.Object(DistLockConfigSchema.properties, { default: {} }) })
 * ```
 *
 * The durations are `$t.Duration()`: `DISTLOCK__TTL=30000` fails validation at `bootstrap()` rather than becoming a
 * lease of 0.
 */
export const DistLockConfigSchema = $t.Object({
  ttl: $t.Optional($t.Duration()),
  wait: $t.Optional($t.Duration()),
  retryDelay: $t.Optional($t.Duration()),
  retryJitter: $t.Optional($t.Number({ minimum: 0, maximum: 1 })),
})

type _Satisfies = SchemaSatisfies<DistLockConfig, InferConfig<typeof DistLockConfigSchema>>
