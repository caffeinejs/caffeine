import { setTimeout as sleep } from 'node:timers/promises'

import { newNoopLogger } from '@caffeinejs/application/logger'
import {
  type Backend,
  CaffeineDistLock,
  DEFAULT_DIST_LOCK_OPTIONS,
  type DistLockOptions,
  type LockLease,
} from '@caffeinejs/distlock'
import { MemoryLockBackend } from '@caffeinejs/distlock/backend/memory'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { exponential } from '@caffeinejs/resilience'
import { type Duration, formatDuration, Millisecond, Minute, Second } from '@caffeinejs/std/duration'
import { createClient } from '@redis/client'

// Every client contends for one key, which is the worst case the retry policy has to handle.
const KEY = 'caffeine:bench:distlock:contention'
const CLIENTS = [2, 8, 32]
const ACQUISITIONS = 2_000
const HOLD: Duration = 1 * Millisecond
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

// Large enough that no acquisition gives up: a timeout would hide the longest wait this run exists to measure.
const WAIT: Duration = 10 * Minute

/** Counts the backend calls a run makes, so attempts and commands are measured rather than inferred. */
class CountingBackend implements Backend {
  attempts = 0
  commands = 0
  readonly #inner: Backend

  constructor(inner: Backend) {
    this.#inner = inner
  }

  tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.attempts++
    this.commands++
    return this.#inner.tryAcquire(key, ttl, signal)
  }

  extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.commands++
    return this.#inner.extend(lease, ttl, signal)
  }

  release(lease: LockLease, signal?: AbortSignal): Promise<void> {
    this.commands++
    return this.#inner.release(lease, signal)
  }
}

interface Policy {
  name: string
  options: Partial<DistLockOptions>
}

// The same first pause and the same jitter band in both: the only difference is whether the pause grows. A
// `maxRetryDelay` equal to `retryDelay` would cut the band at the delay itself and make every fixed pause shorter.
const policies: Policy[] = [
  {
    name: 'fixed delay',
    options: {
      backoff: exponential({
        initialDelay: DEFAULT_DIST_LOCK_OPTIONS.retryDelay,
        multiplier: 1,
        jitter: DEFAULT_DIST_LOCK_OPTIONS.retryJitter,
      }),
    },
  },
  { name: 'exponential', options: {} },
]

interface Row {
  backend: string
  policy: string
  clients: number
  p50: string
  p99: string
  'longest wait': string
  're-acquired by releaser': string
  'attempts / acq': string
  'commands / acq': string
  'acq / s': string
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

const ms = (d: Duration): string => (d < 10 ? `${d.toFixed(2)}ms` : formatDuration(Math.round(d)))

async function run(backendName: string, inner: Backend, policy: Policy, clients: number): Promise<Row> {
  const backend = new CountingBackend(inner)
  const lock = new CaffeineDistLock(backend, { ...DEFAULT_DIST_LOCK_OPTIONS, ...policy.options }, newNoopLogger())
  const latencies: number[] = []
  let remaining = ACQUISITIONS
  let lastHolder = -1
  let reacquired = 0

  const client = async (_: unknown, id: number): Promise<void> => {
    while (remaining > 0) {
      remaining--
      const started = performance.now()
      const held = await lock.acquire(KEY, { wait: WAIT })
      latencies.push(performance.now() - started)
      if (lastHolder === id) {
        reacquired++
      }
      lastHolder = id
      await sleep(HOLD)
      await held.release()
    }
  }

  const started = performance.now()
  await Promise.all(Array.from({ length: clients }, client))
  const elapsed = performance.now() - started
  await lock.onDestroy()

  latencies.sort((a, b) => a - b)

  return {
    backend: backendName,
    policy: policy.name,
    clients,
    p50: ms(percentile(latencies, 50)),
    p99: ms(percentile(latencies, 99)),
    'longest wait': ms(latencies.at(-1)!),
    're-acquired by releaser': `${((reacquired / ACQUISITIONS) * 100).toFixed(1)}%`,
    'attempts / acq': (backend.attempts / ACQUISITIONS).toFixed(2),
    'commands / acq': (backend.commands / ACQUISITIONS).toFixed(2),
    'acq / s': Math.round(ACQUISITIONS / (elapsed / Second)).toString(),
  }
}

const redis = createClient({ url: REDIS_URL })
await redis.connect()

const backends: Array<[name: string, backend: Backend]> = [
  ['memory', new MemoryLockBackend()],
  ['redis', new RedisLockBackend(redis)],
]

console.log(`${ACQUISITIONS} acquisitions per run, one key, hold ${formatDuration(HOLD)}, Redis at ${REDIS_URL}`)
// Each client asks again the moment it releases, before any sleeping waiter wakes, so most acquisitions go back
// to the client that just released. p50 is then that uncontended path; p99 and the longest wait are the waiters'.
console.log('"re-acquired by releaser" is the share of acquisitions taken by the client that released last\n')

try {
  const rows: Row[] = []
  for (const [name, backend] of backends) {
    for (const clients of CLIENTS) {
      for (const policy of policies) {
        rows.push(await run(name, backend, policy, clients))
      }
    }
  }

  console.table(rows)
} finally {
  await redis.del(KEY)
  await redis.close()
}
