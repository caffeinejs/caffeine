import { createAnnotation } from '@caffeinejs/di'

import type { CampaignOptions } from '../election/election.js'
import { annotated, type LockDecorator } from './decorator.js'

/** What `@LeaderOnly` takes. */
export type LeaderOnlyOptions = Pick<CampaignOptions, 'ttl'>

/**
 * Runs the method only on the replica currently elected for the key, and resolves to `undefined` without running
 * everywhere else.
 *
 * Every replica campaigns for the key from `bootstrap()`, with {@link DistLock.campaign}, until the application
 * closes; one campaign per key serves every method that names it, with the options of the first one found. A call
 * made before the first election settles is skipped. Leadership is what this replica believes, and is not exclusive
 * across a pause longer than the lease.
 *
 * @throws ErrInvalidLockKey when the class is defined, if the key is empty or not a string.
 * @example
 * ```ts
 * class Scheduler {
 *   @LeaderOnly('scheduler')
 *   async tick(): Promise<void> {
 *     await this.dispatchDue()
 *   }
 * }
 * ```
 */
export const LeaderOnly = createAnnotation.on('method')((key: string, options?: LeaderOnlyOptions) =>
  annotated(key, options),
) as unknown as LockDecorator<LeaderOnlyOptions>
