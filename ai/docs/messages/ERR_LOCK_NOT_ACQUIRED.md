# ERR_LOCK_NOT_ACQUIRED

Thrown as `ErrLockNotAcquired` from `@caffeinejs/distlock` by `acquire` and `withLock` when its `wait` budget ran out and the last attempt found the key held. The caller holds nothing. The message names the key and the `wait` it spent.

## Do

When a run that finds the work already going should skip it, do not wait at all:

```ts
const { executed } = await lock.tryWithLock('catalog:sync', held => syncCatalog(held.signal))
```

When it must run, and the holder's work is long, wait longer:

```ts
import { Second } from '@caffeinejs/std/duration'

await lock.withLock('catalog:sync', held => syncCatalog(held.signal), { wait: 30 * Second })
```

Branch on `err.code === 'ERR_LOCK_NOT_ACQUIRED'` or `err instanceof ErrLockNotAcquired`.

## Do not

- Catch it and call `acquire` again in a loop: that is a longer `wait` whose backoff restarts at every call.
- Treat it as a backend failure: the last attempt reached the backend and found the key held. When the last attempt went unanswered, the error is `ERR_LOCK_BACKEND_TIMEOUT`.
- Raise `wait` above the holder's `ttl` to steal the key: a holder that renews keeps it for as long as it runs.
