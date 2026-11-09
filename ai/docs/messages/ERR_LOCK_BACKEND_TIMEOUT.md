# ERR_LOCK_BACKEND_TIMEOUT

Thrown as `ErrLockBackendTimeout` from `@caffeinejs/distlock` when one backend call (`operation`: `acquire`, `extend` or `release`) did not answer within its deadline: `storeTimeout`, or less when the lease would have lapsed first. The call is abandoned, not cancelled; a lease it returns later is released with its own token.

## Do

```ts
DistributedLock(d => d.backend(new RedisLockBackend(client)).storeTimeout(5 * Second))
```

Give the store client a timeout of its own as well, so a call the lock stopped waiting for does not hold its connection: a command timeout on the Redis client. `acquire` retries a timed-out attempt while its `wait` remains; branch on `err.code` when it still rejects.

## Do not

- Set `storeTimeout` to `0` to mean "no bound": it is refused, because a store that stops answering would hang every caller and shutdown.
- Treat the key as held after this error: the caller never got a lease.
- Retry `release()` in a loop: the lease lapses at `expiresAt` on its own.
