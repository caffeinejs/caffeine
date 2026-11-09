import { randomUUID } from 'node:crypto'

import { Millisecond, Second, type Duration } from '@caffeinejs/std/duration'

import type { Backend, LockLease } from '../backend.js'

/** What every case of {@link lockBackendContract} runs against. */
export interface BackendContractContext {
  readonly backend: Backend
  /** A key no other case or run uses. */
  key(this: void): string
  /** Lets `ms` pass on the backend's clock: fake timers in a unit run, a real wait against a server. */
  elapse(this: void, ms: Duration): Promise<void>
}

/** One behavior a conforming {@link Backend} must show. `run` rejects with an `Error` naming what it observed. */
export interface BackendContractCase {
  readonly name: string
  run(ctx: BackendContractContext): Promise<void>
}

// A lease a case waits out is short; a lease a case needs to stay held across several round trips is long, so a
// busy machine or a slow server cannot lapse it halfway through.
const TTL: Duration = 200 * Millisecond
const LAPSE: Duration = TTL + 50 * Millisecond
const HOLD: Duration = 10 * Second
const SHORT: Duration = 50 * Millisecond
const BURST = 50

function check(name: string, holds: boolean, observed: () => string): asserts holds {
  if (!holds) {
    // A plain `Error`, so any test runner reports it as a failed assertion.
    throw new Error(`Backend contract case "${name}" failed: ${observed()}`)
  }
}

async function acquired(name: string, backend: Backend, key: string, ttl: Duration): Promise<LockLease> {
  const lease = await backend.tryAcquire(key, ttl)
  check(name, lease !== undefined, () => `tryAcquire("${key}") found the key held, expected a lease`)
  return lease
}

async function held(name: string, backend: Backend, key: string, why: string): Promise<void> {
  const lease = await backend.tryAcquire(key, TTL)
  check(name, lease === undefined, () => `${why}: tryAcquire("${key}") returned ${JSON.stringify(lease)}`)
}

// Settles a call, and says whether it rejected.
async function rejected(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call()
    return false
  } catch {
    return true
  }
}

function contractCase(name: string, run: (name: string, ctx: BackendContractContext) => Promise<void>) {
  return { name, run: (ctx: BackendContractContext) => run(name, ctx) }
}

/**
 * The behaviors a conforming {@link Backend} must show, one case each. Run every case against the backend, sharing
 * it or not: each case takes keys of its own from {@link BackendContractContext.key}.
 *
 * A lease's `expiresAt` is checked against this process's clock: a backend that stamps it from a server clock
 * running ahead has to subtract the skew it tolerates, as the SPI says, or the cases on `expiresAt` fail. No case
 * can tell a backend that stamps `expiresAt` when the reply arrives from one that stamps it before the request
 * leaves: only the second is safe.
 *
 * It imports no test runner, so it runs under any:
 *
 * @example
 * ```ts
 * import { setTimeout as sleep } from 'node:timers/promises'
 *
 * const ctx = backendContractContext(new MyBackend(), { elapse: ms => sleep(ms) })
 * it.each(lockBackendContract)('$name', c => c.run(ctx))
 * ```
 */
export const lockBackendContract: readonly BackendContractCase[] = [
  contractCase(
    'hands out a lease whose expiresAt is after the call started and no later than ttl after it returned',
    async (name, { backend, key }) => {
      const k = key()
      const started = Date.now()
      const lease = await acquired(name, backend, k, TTL)
      const returned = Date.now()

      check(
        name,
        lease.key === k && lease.expiresAt > started && lease.expiresAt <= returned + TTL,
        () => `lease ${JSON.stringify(lease)} for "${k}", call ran from ${started} to ${returned}, ttl ${TTL}ms`,
      )
    },
  ),

  contractCase('turns a second acquisition away while the first lease is good', async (name, { backend, key }) => {
    const k = key()
    await acquired(name, backend, k, HOLD)

    await held(name, backend, k, 'a second acquisition got the key')
  }),

  contractCase('hands the key to the next caller once the lease has lapsed', async (name, { backend, key, elapse }) => {
    const k = key()
    await acquired(name, backend, k, TTL)

    await elapse(LAPSE)

    await acquired(name, backend, k, TTL)
  }),

  contractCase('gives each acquisition a token of its own', async (name, { backend, key }) => {
    const k = key()
    const first = await acquired(name, backend, k, HOLD)
    await backend.release(first)
    const second = await acquired(name, backend, k, HOLD)

    check(name, first.token !== second.token, () => `both acquisitions got token "${first.token}"`)
  }),

  contractCase(
    'issues a strictly greater positive fencing token on every acquisition, across release and expiry',
    async (name, { backend, key, elapse }) => {
      const k = key()
      const first = await acquired(name, backend, k, HOLD)
      await backend.release(first)
      const second = await acquired(name, backend, k, TTL)
      await elapse(LAPSE)
      const third = await acquired(name, backend, k, TTL)

      const tokens = [first.fencingToken, second.fencingToken, third.fencingToken]
      check(
        name,
        tokens.every(token => Number.isSafeInteger(token) && token > 0) &&
          tokens[0] < tokens[1] &&
          tokens[1] < tokens[2],
        () => `fencing tokens ${JSON.stringify(tokens)} across a release and an expiry`,
      )
    },
  ),

  contractCase('keeps the fencing token across extend', async (name, { backend, key }) => {
    const k = key()
    const lease = await acquired(name, backend, k, HOLD)

    const extended = await backend.extend(lease, HOLD)

    check(
      name,
      extended !== undefined && extended.fencingToken === lease.fencingToken,
      () => `extend turned fencing token ${lease.fencingToken} into ${JSON.stringify(extended?.fencingToken)}`,
    )
  }),

  contractCase(
    'extends only while the token matches, and reports loss otherwise',
    async (name, { backend, key, elapse }) => {
      const k = key()
      const stale = await acquired(name, backend, k, TTL)
      await elapse(LAPSE)
      const current = await acquired(name, backend, k, HOLD)

      const fromStale = await backend.extend(stale, HOLD)
      check(name, fromStale === undefined, () => `extend of a superseded lease returned ${JSON.stringify(fromStale)}`)

      const fromCurrent = await backend.extend(current, HOLD)
      check(name, fromCurrent !== undefined, () => 'extend of the current lease returned undefined')
    },
  ),

  contractCase('never brings a released or lapsed key back through extend', async (name, { backend, key, elapse }) => {
    const released = key()
    const lease = await acquired(name, backend, released, HOLD)
    await backend.release(lease)
    const afterRelease = await backend.extend(lease, HOLD)
    check(name, afterRelease === undefined, () => `extend after release returned ${JSON.stringify(afterRelease)}`)
    await acquired(name, backend, released, TTL)

    const lapsed = key()
    const old = await acquired(name, backend, lapsed, TTL)
    await elapse(LAPSE)
    const afterLapse = await backend.extend(old, HOLD)
    check(name, afterLapse === undefined, () => `extend after the lease lapsed returned ${JSON.stringify(afterLapse)}`)
    await acquired(name, backend, lapsed, TTL)
  }),

  contractCase('releases only while the token matches', async (name, { backend, key, elapse }) => {
    const k = key()
    const stale = await acquired(name, backend, k, TTL)
    await elapse(LAPSE)
    await acquired(name, backend, k, HOLD)

    await backend.release(stale)

    await held(name, backend, k, 'a superseded lease released the key')
  }),

  // Extending by less than is left must shorten the lease: a backend that adds, or that keeps the longer of the
  // two, holds the key past what its caller asked for.
  contractCase(
    'sets the remaining validity on extend rather than adding to it or keeping the longer one',
    async (name, { backend, key, elapse }) => {
      const k = key()
      const lease = await acquired(name, backend, k, HOLD)

      const extended = await backend.extend(lease, SHORT)
      const returned = Date.now()
      check(
        name,
        extended !== undefined && extended.expiresAt <= returned + SHORT,
        () => `extend by ${SHORT}ms returned ${JSON.stringify(extended)} at ${returned}`,
      )

      await elapse(SHORT + 50 * Millisecond)
      await acquired(name, backend, k, TTL)
    },
  ),

  contractCase(
    `hands exactly one lease to a burst of ${BURST} concurrent attempts on one key`,
    async (name, { backend, key }) => {
      const k = key()

      const leases = await Promise.all(Array.from({ length: BURST }, () => backend.tryAcquire(k, HOLD)))

      const granted = leases.filter(lease => lease !== undefined).length
      check(name, granted === 1, () => `${granted} of ${BURST} concurrent attempts got a lease`)
    },
  ),

  // A backend may ignore the signal; one that looks at it and rejects must have done nothing.
  contractCase(
    'does nothing when it rejects a call whose signal had already aborted',
    async (name, { backend, key, elapse }) => {
      const aborted = AbortSignal.abort()

      const free = key()
      const acquiring = await rejected(() => backend.tryAcquire(free, HOLD, aborted))
      if (acquiring) {
        await acquired(name, backend, free, TTL)
      }

      const taken = key()
      const lease = await acquired(name, backend, taken, HOLD)
      if (await rejected(() => backend.release(lease, aborted))) {
        await held(name, backend, taken, 'a release that rejected freed the key')
      }

      const lapsing = key()
      const short = await acquired(name, backend, lapsing, SHORT)
      if (await rejected(() => backend.extend(short, HOLD, aborted))) {
        await elapse(SHORT + 50 * Millisecond)
        await acquired(name, backend, lapsing, TTL)
      }
    },
  ),

  contractCase(
    'leaves the key free whenever it rejects an acquisition aborted during the call',
    async (name, { backend, key }) => {
      const k = key()
      const controller = new AbortController()

      const attempt = backend.tryAcquire(k, HOLD, controller.signal)
      controller.abort()

      let lease: LockLease | undefined
      try {
        lease = await attempt
      } catch {
        await acquired(name, backend, k, TTL)
        return
      }

      if (lease !== undefined) {
        await backend.release(lease)
      }
    },
  ),
]

/**
 * Builds the context {@link lockBackendContract} runs against. Keys start with `prefix`, `distlock:contract:` by
 * default, and are unique per call, so a shared server never sees two cases or two runs on one key.
 *
 * `elapse` lets time pass on the backend's clock: a driven fake clock, `Date` included, for a backend in this
 * process, and a real wait for one on a server.
 */
export function backendContractContext(
  backend: Backend,
  options: { elapse: (ms: Duration) => Promise<void>; prefix?: string },
): BackendContractContext {
  const prefix = options.prefix ?? 'distlock:contract:'
  return { backend, key: () => `${prefix}${randomUUID()}`, elapse: options.elapse }
}
