# `@caffeinejs/distlock`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

## Backend

- The backend is mandatory and has no default: omitting `.backend(...)` throws `ErrDistLockConfiguration` while
  the feature configures, and a key that resolves to nothing fails at `app.bootstrap()`. Never fall back to
  `MemoryLockBackend`.
- `Backend.tryAcquire` makes one attempt; waiting, retry, backoff and jitter live in `CaffeineDistLock`.
- The core never computes `LockLease.expiresAt` and never assumes it equals `now + ttl`.
- `extend` and `release` compare the token. `extend` is compare-and-expire, never a write that could put the key
  back; the lease it returns supersedes the one passed in, token included.
- Only `tryAcquire` takes an `AbortSignal`.
- `MemoryLockBackend`, `RedisLockBackend`, `LockEvents` and `instrumentDistLock` stay off `index.ts`, so the
  optional peers `@redis/client` and `@opentelemetry/api` load only when imported.
- `RedisLockBackend` takes a connected client and never connects, closes or reconnects it.

## `once`

- `once` does not release on success: what is left of the lease is the window, measured from acquisition
  (`once.test.ts`).
- A throwing action gives the key back; `releaseOnError: false` opts out.

## Logging, channels and events

- The core publishes to `node:diagnostics_channel` only (`DIST_LOCK_CHANNELS`). `DistLock.events` (`LockEvents`)
  is a facade over those channels; never emit to it directly.
- Logs are direct calls on the service's `Logger`, never a channel subscriber.
- Every traced call reaches `asyncEnd` exactly once, with `outcome` set. `aborted` is the caller's signal, never
  a backend failure.
- Each wrapper checks `hasSubscribers` first (`traced` in `_channels.ts`); `acquire` bypasses the public
  `tryAcquire` so nothing is traced twice.
- `publish` cannot throw into the publisher; `LockEvents` and `instrumentDistLock` catch around their handlers.
- Every context carries `service`.
- `leaseID` ties acquisition, renewals, loss and release together; the token never leaves the core.
- One `warn` per incident (timed-out acquisition, lease found taken, backend failure with `err`, release after
  the lease lapsed, `once` window left standing, listener that threw); its consequences stay at `debug`. Routine
  operations are `debug`; a key found held is `trace`.
- There is no `error` event: `EventEmitter` throws on an `error` nobody listens to.
- Metrics never carry the key; `keyLabel` maps it to the bounded `distlock.key.label`.

## Binding and lifecycle

- `configure` binds `CaffeineDistLock` under the class, named `kDistLock`; user code resolves `kDistLock`.
- `onDestroy` stops renewal timers, awaits a renewal already on the wire (`lifecycle.test.ts`) and releases
  nothing.
- There is no `onBootstrap`. Do not add an empty one to force construction.

## Timers

- Every timer is `setTimeout(...).unref?.()`. A renewal that throws marks the lease lost rather than rejecting
  into the holder.
- `stopRenewal` is a flag, not a `clearTimeout`: a renewal in flight arms the next timer, so `#schedule` alone
  arms one and declines once `#stopped` is set (`once.test.ts`, `lifecycle.test.ts`).
- An explicit `lock.extend(ttl)` is what subsequent renewals run on.

## Scope

- No HTTP: the feature returns `Feature<C>`, installed with `.install(DistributedLock(...))`.
- One lock service per application; there is no `instance` overload.
