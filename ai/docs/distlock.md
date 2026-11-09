# Distributed locks

Package: `@caffeinejs/distlock`. It gives mutual exclusion across every replica of an application, over a backend you install: Redis or Valkey, PostgreSQL, or memory for tests.

A lock never makes a write safe by itself. A replica that pauses longer than its lease (a GC pause, a stalled VM, a partition) wakes up still running the code it started under the lock, after another replica took the key. Use the lease's signal to stop work when it goes, and a fencing token where a stale write would do harm.

## Install

```ts
import { createApplication } from '@caffeinejs/application'
import { DistributedLock, kDistLock } from '@caffeinejs/distlock'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { createClient } from '@redis/client'

const client = await createClient({ url: process.env.REDIS_URL }).connect()

const app = createApplication().install(DistributedLock(d => d.backend(new RedisLockBackend(client))))
await app.bootstrap()

const lock = app.container.get(kDistLock)
```

- The backend has no default. Without `.backend(...)`, configuring the feature throws `ErrDistLockConfiguration`. A memory backend in production would lock each replica against itself only and look like it works.
- The client is yours: the backend never connects, closes or reconnects it. Close it after the application.
- Inject the service with the `kDistLock` key. `DistLock` is an interface and has no runtime identity.
- Defaults, as `Duration`s from `@caffeinejs/std/duration`: `ttl` `30 * Second`, `wait` `5 * Second`, `retryDelay` `50 * Millisecond`, `maxRetryDelay` `1 * Second`, `retryJitter` `0.5`, `storeTimeout` `5 * Second`, `drainTimeout` `5 * Second`. Set them on the builder (`.ttl(10 * Second)`), or pass a configuration slice with `.config(config.app.distlock)`, where a duration is text (`ttl: '10s'`).

## Pick a policy

| You want                                                                    | Call                                   | Decorator             | When another replica has the key        |
| --------------------------------------------------------------------------- | -------------------------------------- | --------------------- | --------------------------------------- |
| A job to run at most once per window, on whichever replica gets there first | `once(key, fn, { ttl })`               | `@Once(key, { ttl })` | Returns `{ executed: false }` at once   |
| Runs never to overlap, and a run that finds one going to skip               | `tryWithLock(key, fn)`                 | `@OneAtATime(key)`    | Returns `{ executed: false }` at once   |
| Runs never to overlap, and a run that finds one going to wait               | `withLock(key, fn, { wait })`          | none                  | Retries until `wait`, then throws       |
| One replica to own a role (a scheduler, a consumer) until it stops          | `campaign(key, { onElected, onLost })` | `@LeaderOnly(key)`    | Keeps campaigning; takes over when free |

```ts
import { Hour } from '@caffeinejs/std/duration'

// At most once per hour across the fleet, even if every replica fires on the same tick.
await lock.once('reports:hourly', () => sendReport(), { ttl: 1 * Hour })

// Skip this tick when the previous sync is still running somewhere.
const { executed } = await lock.tryWithLock('catalog:sync', held => syncCatalog(held.signal))

// One scheduler in the fleet.
const campaign = lock.campaign('scheduler', {
  onElected: held => scheduler.start(held.signal),
  onLost: reason => log.info({ reason }, 'no longer the scheduler'),
})
```

Things these do not do:

- `once` is not exactly once. A key is held for one window, measured from acquisition, and not released on success. A run that throws gives the key back so another replica can retry, unless `releaseOnError: false`. A backend that loses the key (a restart without persistence, a failover) reopens the window.
- `tryWithLock` and `withLock` do not queue. A waiter retries with backoff and jitter; there is no fairness between waiters.
- A campaign does not make leadership exclusive across a pause longer than the lease. `isLeader` is what this process believes; the resource is the judge (see Fencing).

`acquire` and `tryAcquire` hand you the lock to release yourself, with `await using` or `release()` in a `finally`. Prefer the scoped calls above: they release on every path and renew by default.

## Decorators

For an application that runs its own scheduler (`setInterval`, a cron library, a message listener firing a job), the three skipping policies are also decorators. Install their feature beside the lock's:

```ts
import { createApplication } from '@caffeinejs/application'
import { DistributedLock } from '@caffeinejs/distlock'
import { DistLockAOP, LeaderOnly, Once, OneAtATime } from '@caffeinejs/distlock/aop'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { Hour } from '@caffeinejs/std/duration'

createApplication()
  .install(DistributedLock(d => d.backend(new RedisLockBackend(client))))
  .install(DistLockAOP())

class Jobs {
  @Once('cache:warm', { ttl: 1 * Hour })
  async warm(): Promise<void> {}

  @OneAtATime('catalog:sync')
  async sync(): Promise<void> {}

  @LeaderOnly('scheduler')
  async tick(): Promise<void> {}
}
```

- A skipped call resolves to `undefined` without running, so a decorated method returns a promise whose type includes `undefined`: `Promise<void>`, or `Promise<T | undefined>`. Anything else is a type error.
- The key is always explicit. A key derived from the class and method names would change on a rename, and during a rolling deploy the old and the new replicas would not exclude each other.
- `@OneAtATime` never waits: a job that queued behind itself would pile its runs up.
- `@LeaderOnly` campaigns for its key from `bootstrap()` on every replica, one campaign per key, until the application closes. Several methods naming one key share its campaign, with the `ttl` of the first one found. A call made before the first election settled is skipped.
- On one method they apply in a fixed order, whatever order they are written in: `@LeaderOnly`, then `@Once`, then `@OneAtATime`. `@LeaderOnly` with `@OneAtATime` keeps the job on one replica and still keeps a slow run from overlapping the next tick. Give them different keys (`'scheduler'` and `'scheduler:run'`): the campaign holds its own key while it leads, and `bootstrap()` refuses a method that names one key for both.
- `DistLockAOP()` without `DistributedLock(...)` fails at `bootstrap()` with `ErrFeatureNotInstalled`. Without `DistLockAOP()`, the decorators only write annotations and nothing reads them: the methods run undecorated.
- Only instance methods of classes the container builds are woven: bind the class, and keep the decorators off static and private methods, which `bootstrap()` refuses.

## Long work and losing the lease

`withLock`, `tryWithLock` and `campaign` renew the lease while the work runs. `acquire`, `tryAcquire` and `once` do not unless you pass `renew: true`: a forgotten lease would renew for as long as the process lives.

Every `Lock` has a `signal` that aborts when the lease is gone: taken by another holder, lapsed by the clock, lost to a backend that stopped answering, lost to the service closing, or released. `signal.reason` is an `ErrLockLost` with a `reason` (`taken`, `expired`, `error`, `shutdown`), or an `ErrLockReleased`.

```ts
import { setTimeout } from 'node:timers/promises'

import { Second } from '@caffeinejs/std/duration'

await lock.withLock('invoices:close', async held => {
  const response = await fetch(ledgerURL, { signal: held.signal })
  await setTimeout(1 * Second, undefined, { signal: held.signal })

  // `pg` takes no signal: check it before each statement.
  held.signal.throwIfAborted()
  await pool.query('UPDATE invoices SET closed = true WHERE batch = $1', [await response.text()])
})
```

Cancellation is cooperative. Pass the signal to every I/O that takes one, and call `held.signal.throwIfAborted()` before the steps that do not. A lost lease cannot recall a write already sent: once a request left the process, only the resource can refuse it.

## Fencing

Every lease carries `fencingToken`, a positive safe integer greater than every token the backend issued for that key before. Renewals keep it. A resource that stores the highest token it has seen and refuses lower ones turns away a holder that resumed after its lease was taken over.

It is not a counter starting at 1, not unique across keys, and not a replacement for the lock: it orders writers, it does not exclude them.

In SQL, write only when your token is newer than the stored one:

```ts
await lock.withLock(`account:${id}`, async held => {
  const { rowCount } = await pool.query('UPDATE accounts SET balance = $2, fence = $3 WHERE id = $1 AND fence < $3', [
    id,
    balance,
    held.fencingToken,
  ])
  if (rowCount === 0) {
    throw new Error(`stale lock holder for account ${id}`)
  }
})
```

In Redis, check and write in one script:

```ts
const write = `
  local stored = tonumber(redis.call('HGET', KEYS[1], 'fence') or '0')
  if tonumber(ARGV[1]) <= stored then return 0 end
  redis.call('HSET', KEYS[1], 'fence', ARGV[1], 'value', ARGV[2])
  return 1`

await lock.withLock(`report:${id}`, async held => {
  const written = await client.eval(write, { keys: [`report:${id}`], arguments: [String(held.fencingToken), body] })
  if (written === 0) {
    throw new Error(`stale lock holder for report ${id}`)
  }
})
```

Tokens are as durable as the backend's clock and data. The included backends floor each token with their clock in microseconds, so a fresh server still issues greater tokens. A failover to a replica that had not received the key, or a clock that steps back, can issue a token that is not greater.

## Deadlines

- `ttl` bounds the lease: how long the key stays held if this process stops renewing it.
- `wait` bounds how long `acquire` and `withLock` retry on contention.
- `storeTimeout` bounds one backend call. An acquisition waits at most `min(storeTimeout, ttl)`. A lease that arrives after the caller stopped waiting is released with its own token.

Neither `wait` nor `storeTimeout` is an end-to-end deadline: one attempt can outlast `wait` by up to `min(storeTimeout, ttl)`, and neither bounds the work you run under the lock. Bound that work with a signal of your own.

Give the store client its own timeout too (a command timeout on the Redis client, `statement_timeout` on the pool). The service stops waiting at `storeTimeout`; it cannot cancel a command already sent.

## Shutdown

Closing the application, in order:

1. Stops every campaign, releasing leadership it holds, waiting up to `storeTimeout`.
2. Waits up to `drainTimeout` for running `withLock`, `tryWithLock` and `once` actions to finish, renewing their leases meanwhile.
3. Aborts every lock still held with `ErrLockLost` reason `shutdown` and logs one warning with the count. It waits up to `storeTimeout` for the releases that follow.

A key it did not see released is left to lapse at its expiry, so no other replica takes it while work that ignored the abort may still write. A `once` window stays standing. Closing takes at most `drainTimeout + 2 × storeTimeout`.

## Backends

| Backend               | Import                                  | Use it for                                      |
| --------------------- | --------------------------------------- | ----------------------------------------------- |
| `RedisLockBackend`    | `@caffeinejs/distlock/backend/redis`    | Redis or Valkey, one server or a cluster        |
| `PostgresLockBackend` | `@caffeinejs/distlock/backend/postgres` | PostgreSQL you already run                      |
| `MemoryLockBackend`   | `@caffeinejs/distlock/backend/memory`   | Tests, and an application that runs one replica |

**Redis and Valkey.** Takes a connected `@redis/client` (or `redis`) client from `createClient()` or `createCluster()`. It is a single-instance lock: a failover to a replica that had not received a key can hand it to a second holder. Each lock key has a fence key in the same cluster slot: `{key}:fence` by default, or `key:fence` when the key carries a hash tag of its own (`{tenant}:orders`). A key with a `{` but no hash tag, such as `{}:orders`, needs `fenceKey` set on a cluster. Never lock a key named like a fence key.

**PostgreSQL.** Takes a `pg` `Pool`. Create the table in a migration:

```ts
import { PostgresLockBackend, postgresLockTableDDL } from '@caffeinejs/distlock/backend/postgres'
import { Second } from '@caffeinejs/std/duration'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 5 * Second })
await pool.query(postgresLockTableDDL('caffeine_locks'))

DistributedLock(d => d.backend(new PostgresLockBackend(pool, { table: 'caffeine_locks' })))
```

Leases are timed by the database clock. A row lives while its key is held and release deletes it; a row whose `expires_at` has passed may be deleted at any time without breaking fencing. It expects the default `read committed` isolation.

**Your own.** Implement `Backend` from `@caffeinejs/distlock`: one attempt per call, token-checked `extend` and `release`, an increasing `fencingToken`. Prove it with the contract suite:

```ts
import { setTimeout } from 'node:timers/promises'

import { backendContractContext, lockBackendContract } from '@caffeinejs/distlock/testing'
import { it } from 'vitest'

const ctx = backendContractContext(new MyBackend(), { elapse: ms => setTimeout(ms) })
it.each(lockBackendContract)('$name', c => c.run(ctx))
```

## Telemetry

- **Logs** go to the application logger: one `warn` per incident, routine operations at `debug`. Turn them off with `.logger(false)`.
- **Events.** `lock.events.on('lost', message => ...)` for `acquire`, `withLock`, `once`, `extend`, `release`, `contended`, `lost` and `election`. A listener that throws is logged and never reaches the lock.
- **Channels.** The same data on `node:diagnostics_channel`, named in `DIST_LOCK_CHANNELS` from `@caffeinejs/distlock/observability`.
- **OpenTelemetry.** `instrumentDistLock()` from `@caffeinejs/distlock/observability/otel` records spans (`distlock.acquire`, `distlock.withLock`, `distlock.once`, `distlock.extend`, `distlock.release`) and metrics: `distlock.acquire.duration`, `distlock.acquire.attempts`, `distlock.hold.duration`, `distlock.contended`, `distlock.lease.lost`, `distlock.backend.errors`, `distlock.once`, `distlock.election` and `distlock.leader`. It returns the function that stops it.

```ts
import { instrumentDistLock } from '@caffeinejs/distlock/observability/otel'

instrumentDistLock({ keyLabel: key => key.split(':')[0] })
```

Metrics never carry the key: keys are chosen per call and unbounded. `keyLabel` maps a key to a bounded label (`orders:42` to `orders`) put on metrics as `distlock.key.label`; spans carry the full key.
