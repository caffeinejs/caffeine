import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { DistLockBuilder } from './builder.js'

/** The callback an application writes to configure the distributed lock feature. */
export type DistLockConfigure<C = unknown> = FeatureConfigurer<DistLockBuilder<C>, C>

/**
 * Installs distributed locking, publishing the lock service under the `kDistLock` key.
 *
 * A backend is mandatory, and `MemoryLockBackend` comes from `@caffeinejs/distlock/backend/memory`:
 *
 * ```ts
 * .with(distlock(d => d.backend(new MemoryLockBackend()).ttl('1m')))
 * ```
 */
export function distlock<C = unknown>(configure?: DistLockConfigure<C>): Feature<C> {
  return new DistLockBuilder<C>(configure as never)
}
