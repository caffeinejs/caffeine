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

The same rule covers observability. `@caffeinejs/distlock/observability` (channel names, context types,
`LockEvents`) and `@caffeinejs/distlock/observability/otel` (`instrumentDistLock`) are not in `index.ts`.
`@opentelemetry/api` is an **optional** peer that only `observability/otel` imports, so an application without
OpenTelemetry never loads it. The core does import `observability/channels.ts` and `observability/events.ts`:
neither has a dependency beyond Node.

## Logging, channels and events

Three consumers, one set of emission points in the core:

- **Logs** are direct calls on the service's `Logger`. The constructor requires one; `.logger(...)` on the
  builder picks it — unset, it is the application logger's child named `distlock`, resolved inside the factory
  so it sees the logger the application settled on during `ready()`; `false` gives `newNoopLogger()`. Logs are
  not a channel subscriber: channels are process-wide, and one would mix every service's records into one
  logger.
- **`node:diagnostics_channel`** is what the core publishes and the only thing it publishes to. `acquire`,
  `withLock`, `once`, `extend` and `release` are tracing channels; `contended` and `lost` are plain ones. Names
  are in `DIST_LOCK_CHANNELS`.
- **`DistLock.events`** (`LockEvents`, a typed `EventEmitter`) is a facade over those channels, never emitted
  to directly. It re-emits each tracing channel's context at `asyncEnd` and each plain message, kept to its own
  service.

This is why both surfaces exist and why the channels are the source: `EventEmitter` is the friendlier API for
application code, and channels are what instrumentation consumes — a `tracingChannel` wraps the call itself, so
`start` fires before the work runs, which no event emitted afterwards can reconstruct. `@redis/client` 6 is built
the same way.

Rules the emission points keep:

- Every traced call reaches `asyncEnd` exactly once, success or failure; on a rejection `error` comes just
  before it. By then the context carries `outcome`. An acquisition's outcome is one of `acquired`, `held`,
  `timeout`, `aborted`, `error`: `aborted` is the caller's signal, never a backend failure, and a backend that
  rejects because the caller aborted is not logged as one.
- Each wrapper checks `hasSubscribers` first (`traced` in `_channels.ts`). With nobody listening, no context is
  built and no `tracePromise` runs. `acquire` calls a private path rather than the public `tryAcquire`, so
  nothing is traced twice.
- Contexts are filled after the state they describe has changed, inside the traced function, so a subscriber at
  `asyncEnd` sees the lease as it now is. The subscriber runs before the caller's `await` resumes.
- `publish` cannot throw into the publisher, so the core needs no guard: a subscriber cannot corrupt lock
  state. A raw subscriber that throws comes back as an uncaught exception; `LockEvents` and
  `instrumentDistLock` catch around their own handlers for that reason.
- Every context carries `service`. Channels are process-wide, and it is the only way to tell two services
  apart.
- `leaseID` is a process-wide counter assigned when a `HeldLock` is built. It ties acquisition, renewals, loss
  and release together; the token never leaves the core.
- `lapsed` on `withLock`, `once` and `release` is the critical section outrunning its lease — the one failure
  `lost` cannot show eagerly, since it is a getter nobody calls.

Logs are one `warn` per incident: a timed-out acquisition, a lease found taken, a backend failure (with `err`),
a release after the lease lapsed by the clock, a `once` window left standing after it lapsed, a listener that
threw. The consequence of an incident already warned about stays at `debug` — the lost lease a failed renewal
caused, the acquisition a backend failure ended, the lapse of a lease already reported lost. Routine operations
are `debug`; an attempt that found the key held is `trace`.

`LockEvents` subscribes to an event's channel when the event's first listener arrives and unsubscribes when the
last one leaves, through its own `newListener` / `removeListener` hooks. `removeAllListeners()` would take those
hooks too, so it puts them back; it also has to call the base with no argument at all, because Node tells
"remove everything" apart by the argument count. `onDestroy` removes every listener after waiting for in-flight
renewals, so those still reach them. `.on(...)` on the builder attaches listeners in the factory, before any
lock can be taken — including one taken in another binding's `onBootstrap`. Unlike a setter it adds rather than
replaces. There is no `error` event: `EventEmitter` throws on an `error` nobody listens to.

`instrumentDistLock` subscribes to the channels directly rather than through the facade, since it is
process-wide. Metrics never carry the key; `keyLabel` maps it to the bounded `distlock.key.label`. A renewal is
a root span linked to the span active when the lock was taken: it runs from a timer, long after that span may
have ended.

Known limits:

- `tracingChannel` still carries `@experimental` in @types/node. `LockEvents` depends on it as much as the
  channels do.
- A channel subscriber cannot make a span active for the traced call it observes: that would take
  `start.bindStore` over OpenTelemetry's `AsyncLocalStorage`, which OpenTelemetry JS does not expose. This
  package's own nesting is carried on the contexts instead — an acquisition inside `withLock` or `once`, and
  a release inside `withLock`, name that call in `parent`, and the adapter parents the span on it. A backend
  client's spans (node-redis `SET NX`) have no such link, so they come out as siblings of `distlock.acquire`.
- Not observed at all: a lock that is never released, `onDestroy` stopping renewals, a lease that lapses with
  nobody releasing it, `Lock.extend()` on a lease already lost (no backend call), and a quorum backend's
  internal rounds.

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
