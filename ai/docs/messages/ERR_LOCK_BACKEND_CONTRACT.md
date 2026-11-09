# ERR_LOCK_BACKEND_CONTRACT

Thrown as `ErrLockBackendContract` from `@caffeinejs/distlock` when a lock backend returned a lease that breaks the backend contract: its `fencingToken` is not a positive safe integer, or `extend` returned a different `fencingToken` from the lease it was given. A resource could not order writes by that token, so the lease is given back. From `tryAcquire`, `acquire`, `withLock` or `once`, the caller never gets the lock; from `lock.extend()` or a renewal, the holder loses it, and `lock.signal` aborts with `ERR_LOCK_LOST` and reason `error`.

## Do

```ts
class CounterBackend implements Backend {
  async tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    // Take the key and read the next number for it in one atomic step of your store.
    const taken = await this.store.takeAndNumber(key, ttl)
    return taken && { key, token: taken.token, fencingToken: taken.number, expiresAt: taken.expiresAt }
  }

  async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    const expiresAt = await this.store.pushExpiry(lease.key, lease.token, ttl)
    return expiresAt === undefined ? undefined : { ...lease, expiresAt }
  }
}
```

Issue a token per key that is greater than every token the key had before, across releases, expiries and restarts, and return the lease's own token from `extend`. `MemoryLockBackend` and `RedisLockBackend` already do.

## Do not

- Retry the call: the backend answers the same way.
- Write the Redis backend's fence key (`{key}:fence`) by hand.
