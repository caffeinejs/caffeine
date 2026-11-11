# @caffeinejs/distlock

Distributed locks for Caffeine applications: mutual exclusion across every replica, run-once jobs and leader
election, over Redis or Valkey, PostgreSQL, or memory for tests. Scoped work renews its lease while it runs, every
lease aborts a signal when it is lost, and carries a fencing token a resource can check.

```sh
npm install -E @caffeinejs/distlock @caffeinejs/resilience @caffeinejs/std
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

| Import from                               | What                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `@caffeinejs/distlock`                    | `DistributedLock()`, `kDistLock`, the `DistLock` and `Lock` types, errors              |
| `@caffeinejs/distlock/aop`                | `@Once`, `@OneAtATime`, `@LeaderOnly` and the `DistLockAOP()` feature that weaves them |
| `@caffeinejs/distlock/backend/redis`      | `RedisLockBackend`, with `@redis/client` installed                                     |
| `@caffeinejs/distlock/backend/postgres`   | `PostgresLockBackend`, `postgresLockTableDDL`, with `pg` installed                     |
| `@caffeinejs/distlock/backend/memory`     | `MemoryLockBackend`, for tests and single-replica applications                         |
| `@caffeinejs/distlock/observability`      | `LockEvents`, `DIST_LOCK_CHANNELS` and the event types                                 |
| `@caffeinejs/distlock/observability/otel` | `instrumentDistLock`, with `@opentelemetry/api` installed                              |
| `@caffeinejs/distlock/testing`            | `lockBackendContract`, the suite a custom backend must pass                            |

## Quick start

The backend has no default: install one.

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

Skip a run when another replica is already doing it:

```ts
const { executed } = await lock.tryWithLock('catalog:sync', held => syncCatalog(held.signal))
```

Run a job at most once per hour across the fleet:

```ts
import { Hour } from '@caffeinejs/std/duration'

await lock.once('reports:hourly', () => sendReport(), { ttl: 1 * Hour })
```

Keep one replica in charge of a role:

```ts
const campaign = lock.campaign('scheduler', {
  onElected: held => scheduler.start(held.signal),
  onLost: reason => log.info({ reason }, 'no longer the scheduler'),
})
```

With a scheduler of your own, the same policies are decorators, woven by `DistLockAOP()` installed beside
`DistributedLock(...)`:

```ts
class Scheduler {
  @LeaderOnly('scheduler')
  async tick(): Promise<void> {
    await this.dispatchDue()
  }
}
```

The usage guide covers the decorators, losing a lease, fencing tokens, deadlines, shutdown, backends and telemetry:
[`ai/docs/distlock.md`](../ai/docs/distlock.md).

## License

[MIT](LICENSE)
