# ERR_INVALID_LOCK_KEY

Thrown as `ErrInvalidLockKey` from `@caffeinejs/distlock` by `tryAcquire`, `acquire`, `withLock` and `once` when the key is empty or not a string. Nothing reaches the backend and nothing is published.

## Do

```ts
await lock.withLock(`orders:rebuild:${tenantID}`, rebuild)
```

Name the resource the lock protects, and check that every part of a composed key is set before the call.

## Do not

- Pass a number, `undefined` or an object and expect it to be turned into a string.
- Catch this error to fall back to running without the lock.
