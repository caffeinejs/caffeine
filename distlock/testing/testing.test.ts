import { randomUUID } from 'node:crypto'

import { type Duration } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from '../backend.js'
import { MemoryLockBackend } from '../backend/memory/index.js'
import { backendContractContext, lockBackendContract, type BackendContractContext } from './index.js'

type Fault =
  | 'badExpiry'
  | 'noExclusion'
  | 'neverExpires'
  | 'fixedToken'
  | 'noFence'
  | 'resetFence'
  | 'extendChangesFence'
  | 'extendIgnoresToken'
  | 'extendRecreates'
  | 'releaseIgnoresToken'
  | 'extendAdds'
  | 'extendKeepsLonger'
  | 'racyAcquire'
  | 'ignoresAbortedSignal'
  | 'actsOnAbortedSignal'
  | 'rejectsAfterWrite'
  | 'extendRefusesAll'
  | 'rejectsWhenAbortedMidCall'
  | 'answersNothingWhenAbortedMidCall'

interface Held {
  token: string
  fencingToken: number
  expiresAt: number
}

/** A backend that conforms until one fault is switched on, so each case can be shown to fail. */
class BrokenBackend implements Backend {
  readonly #fault: Fault | undefined
  readonly #held = new Map<string, Held>()
  readonly #fences = new Map<string, number>()

  constructor(fault?: Fault) {
    this.#fault = fault
  }

  async tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.#checkSignal(signal)
    // Conforming: looks at the signal again on a later turn, before writing anything.
    if (this.#fault === 'rejectsWhenAbortedMidCall' || this.#fault === 'answersNothingWhenAbortedMidCall') {
      await Promise.resolve()
      if (signal?.aborted === true) {
        if (this.#fault === 'rejectsWhenAbortedMidCall') {
          throw signal.reason
        }
        return undefined
      }
    }
    const free = !this.#holds(key)
    if (this.#fault === 'racyAcquire') {
      // Reads, then writes on a later turn: every attempt in a burst sees the key free.
      await Promise.resolve()
    }
    if (!free && this.#fault !== 'noExclusion') {
      return undefined
    }

    const last = this.#fences.get(key) ?? 0
    const fencingToken = this.#fault === 'noFence' ? 0 : this.#fault === 'resetFence' ? 1 : last + 1
    this.#fences.set(key, fencingToken)
    const held = {
      token: this.#fault === 'fixedToken' ? 'fixed' : randomUUID(),
      fencingToken,
      expiresAt: Date.now() + ttl,
    }
    this.#held.set(key, held)

    if (this.#fault === 'rejectsAfterWrite') {
      await Promise.resolve()
      signal?.throwIfAborted()
    }

    this.#afterwards(signal)

    // The key lapses at `held.expiresAt`; the lease this fault hands out claims longer.
    const expiresAt = this.#fault === 'badExpiry' ? held.expiresAt + ttl : held.expiresAt
    return { key, token: held.token, fencingToken, expiresAt }
  }

  async extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.#checkSignal(signal)
    let held = this.#holds(lease.key) ? this.#held.get(lease.key) : undefined
    if (held === undefined && this.#fault === 'extendRecreates') {
      held = { token: lease.token, fencingToken: lease.fencingToken, expiresAt: Date.now() }
      this.#held.set(lease.key, held)
    }
    if (
      held === undefined ||
      this.#fault === 'extendRefusesAll' ||
      (held.token !== lease.token && this.#fault !== 'extendIgnoresToken')
    ) {
      return undefined
    }

    const requested = Date.now() + ttl
    held.expiresAt =
      this.#fault === 'extendAdds'
        ? held.expiresAt + ttl
        : this.#fault === 'extendKeepsLonger'
          ? Math.max(held.expiresAt, requested)
          : requested
    const fencingToken = this.#fault === 'extendChangesFence' ? held.fencingToken + 1 : held.fencingToken
    this.#afterwards(signal)
    return { ...lease, fencingToken, expiresAt: held.expiresAt }
  }

  async release(lease: LockLease, signal?: AbortSignal): Promise<void> {
    this.#checkSignal(signal)
    const held = this.#held.get(lease.key)
    if (held !== undefined && (held.token === lease.token || this.#fault === 'releaseIgnoresToken')) {
      this.#held.delete(lease.key)
    }
    this.#afterwards(signal)
  }

  #holds(key: string): boolean {
    const held = this.#held.get(key)
    return held !== undefined && (this.#fault === 'neverExpires' || held.expiresAt > Date.now())
  }

  // Rejects an aborted call before it does anything, unless a fault says otherwise.
  #checkSignal(signal: AbortSignal | undefined): void {
    if (this.#fault !== 'ignoresAbortedSignal' && this.#fault !== 'actsOnAbortedSignal') {
      signal?.throwIfAborted()
    }
  }

  // Does the work, then rejects for the signal it should have checked first.
  #afterwards(signal: AbortSignal | undefined): void {
    if (this.#fault === 'actsOnAbortedSignal') {
      signal?.throwIfAborted()
    }
  }
}

const elapse = async (ms: Duration): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

function contextFor(backend: Backend): BackendContractContext {
  return backendContractContext(backend, { elapse })
}

async function failing(backend: Backend): Promise<string[]> {
  const ctx = contextFor(backend)
  const failed: string[] = []
  for (const c of lockBackendContract) {
    try {
      await c.run(ctx)
    } catch {
      failed.push(c.name)
    }
  }
  return failed
}

const NAMES = lockBackendContract.map(c => c.name)
const named = (...indexes: number[]): string[] => indexes.map(i => NAMES[i - 1])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('lockBackendContract', () => {
  it.each(lockBackendContract.map(c => [c.name, c] as const))('MemoryLockBackend: %s', async (_, c) => {
    await c.run(contextFor(new MemoryLockBackend()))
  })

  it('passes every case against a backend with no fault', async () => {
    expect(await failing(new BrokenBackend())).toEqual([])
  })

  // The SPI lets a backend ignore the signal: the core bounds every call itself.
  it('passes every case against a backend that ignores the signal', async () => {
    expect(await failing(new BrokenBackend('ignoresAbortedSignal'))).toEqual([])
  })

  // A backend that notices the abort before writing may reject or answer with no lease: either leaves the key as
  // it was, and neither may be failed for it.
  it.each<Fault>(['rejectsWhenAbortedMidCall', 'answersNothingWhenAbortedMidCall'])(
    'passes every case against a backend that %s',
    async fault => {
      expect(await failing(new BrokenBackend(fault))).toEqual([])
    },
  )

  // A case that cannot fail proves nothing (AGENTS.md Rule 9): each fault must fail its own case. A fault that
  // necessarily breaks more than one behavior fails exactly the cases listed.
  it.each<[Fault, number[]]>([
    ['badExpiry', [1]],
    ['noExclusion', [2, 9, 11, 12]],
    ['neverExpires', [3, 5, 7, 8, 9, 10, 12]],
    ['fixedToken', [4, 7, 9]],
    ['noFence', [5]],
    ['resetFence', [5]],
    ['extendChangesFence', [6]],
    ['extendIgnoresToken', [7]],
    ['extendRecreates', [8]],
    ['releaseIgnoresToken', [9]],
    ['extendAdds', [10]],
    ['extendKeepsLonger', [10]],
    ['racyAcquire', [11]],
    ['actsOnAbortedSignal', [12]],
    ['rejectsAfterWrite', [13]],
    ['extendRefusesAll', [6, 7, 10]],
  ])('fails against %s exactly the cases %j', async (fault, cases) => {
    expect(await failing(new BrokenBackend(fault))).toEqual(named(...cases))
  })

  it('names the case and what it observed when a backend fails it', async () => {
    const error = await lockBackendContract[1].run(contextFor(new BrokenBackend('noExclusion'))).catch(e => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /^Backend contract case "turns a second acquisition away while the first lease is good" failed: a second acquisition got the key: tryAcquire\("[^"]+"\) returned \{/,
    )
  })

  it('hands out a key of its own on every call, under the prefix', () => {
    const ctx = backendContractContext(new MemoryLockBackend(), { elapse, prefix: 'app:' })

    const [a, b] = [ctx.key(), ctx.key()]

    expect(a).not.toBe(b)
    expect(a.startsWith('app:')).toBe(true)
    expect(backendContractContext(new MemoryLockBackend(), { elapse }).key().startsWith('distlock:contract:')).toBe(
      true,
    )
  })
})
