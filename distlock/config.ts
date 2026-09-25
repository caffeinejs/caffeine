import { type Duration } from '@caffeinejs/std/duration'
import { $t } from '@caffeinejs/std/schema'

/**
 * The distributed lock slice of the configuration tree. Every duration accepts `'5s'`-style strings or
 * milliseconds.
 *
 * The backend is not here: it is an object with methods, so it cannot travel a configuration tree. It stays
 * on the builder.
 */
export interface DistLockConfigSlice {
  ttl?: Duration
  wait?: Duration
  retryDelay?: Duration
  retryJitter?: number
}

/**
 * The schema governing the distributed lock slice.
 *
 * Every member is optional and nothing is defaulted here — `DEFAULT_DIST_LOCK_OPTIONS` already owns the
 * defaults, and duplicating them would give two places to change the lease duration.
 *
 * Splice it into an application schema rather than restating the fields, and give the block itself a default
 * so a deployment that tunes nothing still validates:
 *
 * ```ts
 * $t.Object({ distlock: $t.Object(distLockConfigSchema.properties, { default: {} }) })
 * ```
 */
export const distLockConfigSchema = $t.Object({
  ttl: $t.Optional($t.Union([$t.String(), $t.Number()])),
  wait: $t.Optional($t.Union([$t.String(), $t.Number()])),
  retryDelay: $t.Optional($t.Union([$t.String(), $t.Number()])),
  retryJitter: $t.Optional($t.Number({ minimum: 0, maximum: 1 })),
})
