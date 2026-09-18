# `@caffeinejs/distlock`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## The backend is mandatory and has no default

`distlock()` installs nothing usable on its own: `.backend(...)` takes an instance or a key to resolve one
from the container, and omitting it throws `ErrDistLockConfiguration` while the feature configures. A key that
resolves to nothing throws too, from the factory the container runs during `init()` — so both failures land at
`app.ready()` rather than at the first lock a request tries to take.

There is deliberately no fallback to `MemoryLockBackend`. A lock service that quietly degraded to a
single-process backend would hand a fleet the one answer it must never give, and it would do it silently.

## `once` does not release on success

`once` acquires the key, runs the action, and then leaves the key alone. What is left of the lease **is** the
window, and it is what turns away a caller arriving after the action finished as much as one arriving during
it. The window is measured from acquisition, not from completion, so a job on a fixed period does not drift.

Adding a release to the success path of `once` breaks the feature and nothing else in the package, which is
why `once.test.ts` pins it with a caller that arrives after the winner is done.

The error path is the opposite: a throwing action gives the key back, because a window closed by work that
never happened keeps every replica out of it. `releaseOnError: false` opts out.

## Retry lives in the core, so the SPI stays single-shot

`Backend.tryAcquire` makes one attempt. Waiting, retrying, backoff and jitter are in `CaffeineDistLock`, so
every backend gets them without writing them, and a backend author's job is three methods over one key.

This is what keeps the SPI implementable at both ends of its range. A single-instance adapter is `SET key
token NX PX ttl` plus a compare-and-delete and a compare-and-expire script. A quorum implementation does its
rounds, its minority cleanup and its clock-drift arithmetic inside `tryAcquire` and reports the outcome
through `LockLease.expiresAt` — which is why the core never computes that field itself and never assumes it
equals `now + ttl`.

`extend` and `release` are token-compared by contract. An unconditional delete releases a key a _different_
holder now owns; `distlock.test.ts` has the test that catches it.

`extend` is compare-and-expire and never a write that could put the key back. A renewal can be in flight when
its holder releases — the core waits for it and releases afterwards, but a backend that recreated the key
would leave it taken for a whole further lease with nobody holding it. The lease `extend` returns supersedes
the one passed in, token included, so a backend may rotate tokens there.

Neither `extend` nor `release` takes an `AbortSignal`. Renewal is a background timer with no caller to speak
for, and a caller that aborted still has to give the key back, so only `tryAcquire` takes one.

## Backends live behind their own export paths

`MemoryLockBackend` is at `@caffeinejs/distlock/backend/memory` and `RedisLockBackend` at
`@caffeinejs/distlock/backend/redis`. Neither is exported from `index.ts`, and nothing reachable from it imports
them, so an application that does not import the Redis backend never loads `@redis/client`. That is also why
`@redis/client` is an **optional** peer dependency: a required one would be installed into every consumer's tree.
It is `@redis/client` rather than `redis` because the client is the only part used; an application that installs
`redis` gets `@redis/client` with it and satisfies the peer.

`RedisLockBackend` takes a connected node-redis client and owns nothing about it — it never connects, closes or
reconnects. It is single-instance: `SET NX PX` to acquire, and two Lua scripts that compare the token before
`PEXPIRE` and `DEL`. `extend` is `PEXPIRE` precisely because it cannot recreate a missing key. There is no quorum,
so a failover to a replica that had not yet received a key can hand it to a second holder. The client type is a
structural two-method interface rather than `RedisClientType`, so a client created with `RESP: 3` or a
`typeMapping` still fits. `test/e2e/distlock.e2e.ts` runs it against a real Redis and a real Valkey.

Why the scripts are `EVAL` rather than `DELEX`, `DELIFEQ` or `SET … IFEQ`: see
[`docs/distlock-redis-backend.md`](../docs/distlock-redis-backend.md).

## Bound by class, resolved by key

`configure` binds `CaffeineDistLock` under **the class**, named `kDistLock`. That is not decoration: the
container reads `onDestroy` off a binding's constructor (`di/container.ts`), and a factory bound under a plain
symbol has no constructor to read, so renewal timers would outlive disposal. The name is what user code
resolves, because `DistLock` is an interface and carries no runtime identity of its own.

`onDestroy` stops renewal timers and releases **nothing**. `withLock` releases on its own path, and a `once`
window has to outlive the process that opened it.

It is `async` because stopping is not instant: a renewal already on the wire cannot be called back, so
disposal waits for it. Once `app.close()` resolves this package has no write outstanding, which is what
`lifecycle.test.ts` asserts with a backend that answers slowly — one that answers synchronously never produces
the case at all.

There is no `onBootstrap`, and adding an empty one to force construction would be cargo cult. A bad backend key
already fails at `app.ready()` rather than at the first lock, because singleton bindings are eager in this
container: `DEFAULT_OPTIONS.lazy` is `false` and `SingletonScope.lazy` is `false`, so `init()` resolves the
binding and a throwing factory rejects `ready()`. `config.test.ts`'s "refuses to start when the backend key
resolves to nothing" is what holds that; if it ever starts failing, the container's defaults changed
underneath this package.

## Timers

Every timer is `setTimeout(...).unref?.()`, and a lock renews at a third of what is left on its lease, so two
renewals may fail before the lease actually lapses. A renewal that throws marks the lease lost rather than
rejecting into whatever the holder is doing.

`stopRenewal` is a flag, not a `clearTimeout`. Clearing the pending timer cannot reach a renewal that already
left, and that renewal is precisely the one that arms the next timer — so `#schedule` declines once `#stopped`
is set, and it is the only place a timer is armed. Without the flag a `once` whose action ends mid-renewal
renews its window forever, untracked and out of `onDestroy`'s reach; `once.test.ts` and `lifecycle.test.ts`
pin both halves of that.

An explicit `lock.extend(ttl)` is what subsequent renewals run on. It is a decision about the lock, not about
one tick of it.

## No HTTP, no named instances

This feature contributes no start-up wiring: no `bootstrap` hook, no `extensions.register`, no dependency on
`@caffeinejs/http`. It installs into a plain `createApplication()`.

There is one lock service per application. If a second one is ever needed, add the `instance` overload the way
`kafka` and `messaging` do and fold the name into `[kFeatureName]` — the single-instance call keeps working.
