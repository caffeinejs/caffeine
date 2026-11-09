import { formatDuration, type Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import type { LostReason } from './observability/channels.js'
import type { StoreOperation, StoreTimeoutBound } from './store_call.js'

/** Base error for the distributed lock integration. */
export class ErrDistLock extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrDistLock'
    this.code = code
  }
}

/** Thrown when the feature is installed without a backend, or with a token nothing is bound to. */
export class ErrDistLockConfiguration extends ErrDistLock {
  constructor(message: string) {
    super(message, 'ERR_DIST_LOCK_CONFIGURATION')
    this.name = 'ErrDistLockConfiguration'
  }
}

/** Thrown when `acquire` spent its whole `wait` budget without taking the key. */
export class ErrLockNotAcquired extends ErrDistLock {
  constructor(key: string, wait: Duration) {
    super(
      errMessage(`Cannot acquire lock "${key}": still held after ${wait}ms`)
        .solutions(
          'Raise the wait budget with { wait: 30 * Second }',
          'Or use tryAcquire and handle the undefined it returns',
        )
        .reference('@caffeinejs/distlock', ErrLockNotAcquired)
        .build(),
      'ERR_LOCK_NOT_ACQUIRED',
    )
    this.name = 'ErrLockNotAcquired'
  }
}

/** Thrown before any backend call when a lock key is empty or not a string. */
export class ErrInvalidLockKey extends ErrDistLock {
  constructor(key: unknown) {
    super(
      errMessage(
        typeof key === 'string'
          ? `Cannot lock on key "${key}": a lock key is a non-empty string`
          : `Cannot lock on a key of type "${typeof key}": a lock key is a non-empty string`,
      )
        .solutions('Name the resource the lock protects, such as "orders:rebuild"')
        .reference('@caffeinejs/distlock', ErrInvalidLockKey)
        .build(),
      'ERR_INVALID_LOCK_KEY',
    )
    this.name = 'ErrInvalidLockKey'
  }
}

/**
 * Thrown when one backend call did not settle within its deadline: `storeTimeout`, or less when the lease would
 * have lapsed first.
 *
 * The call is abandoned, not cancelled. A lease it hands back later is released with its own token.
 */
export class ErrLockBackendTimeout extends ErrDistLock {
  readonly operation: StoreOperation
  readonly key: string
  readonly timeout: Duration

  constructor(operation: StoreOperation, key: string, timeout: Duration, bound: StoreTimeoutBound) {
    super(
      errMessage(
        `Cannot ${operation} the lock on "${key}": the backend did not answer within ${formatDuration(timeout)}`,
      )
        .solutions(
          bound === 'storeTimeout'
            ? 'Raise storeTimeout, such as .storeTimeout(10 * Second)'
            : 'Raise ttl, such as { ttl: 60 * Second }',
        )
        .reference('@caffeinejs/distlock', ErrLockBackendTimeout)
        .build(),
      'ERR_LOCK_BACKEND_TIMEOUT',
    )
    this.name = 'ErrLockBackendTimeout'
    this.operation = operation
    this.key = key
    this.timeout = timeout
  }
}

const LOST_BECAUSE: Record<LostReason, string> = {
  taken: 'another holder took the key',
  expired: 'the lease expired',
  error: 'a renewal could not reach the backend',
  shutdown: 'the lock service is closing',
}

/**
 * What `lock.signal` aborts with when the lease is gone without its holder releasing it. `reason` says how.
 *
 * Stop the work bound to the signal: the key may already belong to another holder.
 */
export class ErrLockLost extends ErrDistLock {
  readonly key: string
  readonly reason: LostReason

  constructor(key: string, reason: LostReason) {
    const message = errMessage(`Cannot keep the lock on "${key}": ${LOST_BECAUSE[reason]}`)
    message.solutions('Stop the work bound to lock.signal and retry it under a new lock')
    if (reason === 'expired') {
      message.solutions('Turn renewal on for work that outlives the lease, such as { renew: true }')
    }

    super(message.reference('@caffeinejs/distlock', ErrLockLost).build(), 'ERR_LOCK_LOST')
    this.name = 'ErrLockLost'
    this.key = key
    this.reason = reason
  }
}

/** What `lock.signal` aborts with once its holder released the lock. */
export class ErrLockReleased extends ErrDistLock {
  readonly key: string

  constructor(key: string) {
    super(
      errMessage(`Cannot use the lock on "${key}": it was released`)
        .reference('@caffeinejs/distlock', ErrLockReleased)
        .build(),
      'ERR_LOCK_RELEASED',
    )
    this.name = 'ErrLockReleased'
    this.key = key
  }
}
