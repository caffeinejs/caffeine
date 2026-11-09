import { createAnnotation } from '@caffeinejs/di'

import type { TryWithLockOptions } from '../distlock.js'
import { annotated, type LockDecorator } from './decorator.js'

/**
 * Runs the method under the key when it is free, as {@link DistLock.tryWithLock} does, and resolves to `undefined`
 * without running while another call holds it, on this replica or any other. The lease renews while the method runs.
 *
 * It never waits: a job that queued behind itself would pile its runs up. Name the key explicitly and keep it across
 * renames: a replica still running the old name would not exclude the new one.
 *
 * @throws ErrInvalidLockKey when the class is defined, if the key is empty or not a string.
 * @example
 * ```ts
 * class Reports {
 *   @OneAtATime('reports:nightly')
 *   async nightly(): Promise<void> {
 *     await this.build()
 *   }
 * }
 * ```
 */
export const OneAtATime = createAnnotation.on('method')((key: string, options?: TryWithLockOptions) =>
  annotated(key, options),
) as unknown as LockDecorator<TryWithLockOptions>
