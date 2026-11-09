import { formatDuration, type Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

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
