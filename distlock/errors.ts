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
  constructor(key: string, waitMs: number) {
    super(
      `Cannot acquire lock "${key}": still held after ${waitMs}ms` +
        '\n  - Raise the wait budget with { wait: "30s" }' +
        '\n  - Or use tryAcquire and handle the undefined it returns',
      'ERR_LOCK_NOT_ACQUIRED',
    )
    this.name = 'ErrLockNotAcquired'
  }
}
