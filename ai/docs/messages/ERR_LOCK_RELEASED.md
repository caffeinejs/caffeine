# ERR_LOCK_RELEASED

The reason `lock.signal` from `@caffeinejs/distlock` aborts with once its holder released the lock, through `lock.release()`, the end of an `await using` block, or `withLock` returning. A lease lost before the release keeps its `ERR_LOCK_LOST` reason instead.

## Do

```ts
const held = await lock.acquire('orders:rebuild')
try {
  await rebuild({ signal: held.signal })
} finally {
  await held.release()
}
```

Bind work started under the lock to `lock.signal`, so nothing it started outlives the lease.

## Do not

- Log this as an incident: the holder asked for it.
- Reuse a released lock: acquire a new one.
