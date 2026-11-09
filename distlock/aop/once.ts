import { createAnnotation } from '@caffeinejs/di'

import type { OnceOptions } from '../distlock.js'
import { annotated, type LockDecorator } from './decorator.js'

/**
 * Runs the method at most once per window across every replica, as {@link DistLock.once} does. A call inside the
 * window, or while another replica runs it, resolves to `undefined` without running.
 *
 * A window, not exactly once: the key is kept for `ttl` from the moment it was taken, and a call that throws gives it
 * back so another replica can retry, unless `releaseOnError` is `false`. Name the key explicitly and keep it across
 * renames: a replica still running the old name would not see the new one.
 *
 * @throws ErrInvalidLockKey when the class is defined, if the key is empty or not a string.
 * @example
 * ```ts
 * class CacheWarmer {
 *   @Once('cache:warm', { ttl: 1 * Hour })
 *   async warm(): Promise<void> {
 *     await this.cache.fill()
 *   }
 * }
 * ```
 */
export const Once = createAnnotation.on('method')((key: string, options?: OnceOptions) =>
  annotated(key, options),
) as unknown as LockDecorator<OnceOptions>
