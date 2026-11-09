# ERR_LOCK_LOST

The reason `lock.signal` from `@caffeinejs/distlock` aborts with when a lease is gone without its holder releasing it. `err.reason` says how: `taken` (another holder has the key), `expired` (the lease lapsed by the clock), or `error` (renewals could not reach the backend while the lease had time).

## Do

```ts
await lock.withLock('orders:rebuild', async held => {
  const res = await fetch(url, { signal: held.signal })
  // ...
})
```

Pass `lock.signal` to the I/O the critical section does, so the work stops with the lease. `withLock` and `tryWithLock` renew the lease while the action runs; for a lock from `acquire` or `tryAcquire` that work can outlive, turn renewal on with `{ renew: true }`. Cancellation is cooperative: a write already sent is not recalled.

## Do not

- Keep writing after the signal aborted: the key may already belong to another holder.
- Treat `reason: 'expired'` on a lease that was not renewing as a backend fault: the lease ran for the `ttl` it was given.
