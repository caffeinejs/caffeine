import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend } from '../backend.js'
import { FaultyBackend } from '../backend.testkit.js'
import { MemoryLockBackend } from '../backend/memory/index.js'
import type { DistLockBuilder } from '../builder.js'
import type { DistLock, Lock } from '../distlock.js'
import { kDistLock } from '../keys.js'
import { RecordingLogger } from '../log.testkit.js'
import type { ElectionMessage, LostReason } from '../observability/channels.js'
import { DistributedLock } from '../plugin.js'
import type { Campaign } from './election.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
  }
  vi.useRealTimers()

  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

// Jitter off and a fixed pause, so a test reads the schedule exactly.
async function newReplica(
  backend: Backend,
  configure?: (d: DistLockBuilder) => void,
): Promise<{ lock: DistLock; close: () => Promise<void> }> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
    DistributedLock(d => {
      d.backend(backend)
        .retryDelay(100 * Millisecond)
        .maxRetryDelay(100 * Millisecond)
        .retryJitter(0)
      configure?.(d)
    }),
  )
  await app.bootstrap()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), close: () => app.close() }
}

function fake(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

const leaders = (campaigns: Campaign[]) => campaigns.filter(c => c.isLeader).length

describe('distlock campaign', () => {
  it('elects exactly one of two campaigners for a key, and the other once the leader stops', async () => {
    const backend = new MemoryLockBackend()
    const [a, b] = [await newReplica(backend), await newReplica(backend)]
    fake()

    const campaigns = [a.lock.campaign('scheduler'), b.lock.campaign('scheduler')]
    await vi.advanceTimersByTimeAsync(0)

    expect(leaders(campaigns)).toBe(1)
    for (let tick = 0; tick < 10; tick++) {
      await vi.advanceTimersByTimeAsync(1 * Second)
      expect(leaders(campaigns)).toBe(1)
    }

    const leader = campaigns.find(c => c.isLeader)!
    const follower = campaigns.find(c => c !== leader)!
    await leader.stop()

    expect(leader.isLeader).toBe(false)
    expect(leader.lock).toBeUndefined()
    // Within one backoff pause.
    await vi.advanceTimersByTimeAsync(100 * Millisecond)
    expect(follower.isLeader).toBe(true)
    expect(leaders(campaigns)).toBe(1)
  })

  it('calls onElected with the lock and onLost with the reason when the lease is taken from under it', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newReplica(backend)
    fake()

    const elected: Lock[] = []
    const lost: LostReason[] = []
    const campaign = lock.campaign('scheduler', {
      ttl: 3 * Second,
      onElected: held => void elected.push(held),
      onLost: reason => void lost.push(reason),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(elected).toEqual([campaign.lock])

    backend.stolen = true
    // The next renewal, at a third of the lease, finds the key gone.
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(lost).toEqual(['taken'])
    expect(campaign.isLeader).toBe(false)
    await campaign.stop()
  })

  // A hook that keeps failing must neither keep the key nor spin: one pause between attempts, one warning in all.
  it('steps down and releases when onElected throws, then campaigns again after one backoff pause', async () => {
    const memory = new MemoryLockBackend()
    const log = new RecordingLogger()
    const { lock } = await newReplica(memory, d => d.logger(log))
    fake()

    let calls = 0
    const campaign = lock.campaign('scheduler', {
      onElected: () => {
        calls += 1
        throw new Error('scheduler would not start')
      },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toBe(1)
    expect(campaign.isLeader).toBe(false)
    // Released: a probe takes the key straight away, then hands it back.
    const probe = await memory.tryAcquire('scheduler', 1 * Second)
    expect(probe).toBeDefined()
    await memory.release(probe!)

    await vi.advanceTimersByTimeAsync(99 * Millisecond)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1 * Millisecond)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(log.at('warn').filter(r => r.msg === 'lock campaign onElected failed')).toHaveLength(1)
    await campaign.stop()
  })

  // A leader that hands its key back must not re-take it in a tight loop and starve the other campaigners.
  it('waits one backoff pause before campaigning again when the leader releases its own lock', async () => {
    const memory = new MemoryLockBackend()
    const { lock } = await newReplica(memory)
    fake()

    let calls = 0
    const lost: LostReason[] = []
    const campaign = lock.campaign('scheduler', {
      onElected: held => {
        calls += 1
        // Bounded, so a missing pause shows as a count rather than a hang.
        if (calls < 5) {
          void held.release()
        }
      },
      onLost: reason => void lost.push(reason),
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toBe(1)
    expect(campaign.isLeader).toBe(false)
    await vi.advanceTimersByTimeAsync(99 * Millisecond)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1 * Millisecond)
    expect(calls).toBe(2)
    expect(lost).toEqual([])
    await campaign.stop()
  })

  it('does not call onLost when the campaign itself is stopped', async () => {
    const { lock } = await newReplica(new MemoryLockBackend())
    fake()

    const lost: LostReason[] = []
    const campaign = lock.campaign('scheduler', { onLost: reason => void lost.push(reason) })
    await vi.advanceTimersByTimeAsync(0)
    expect(campaign.isLeader).toBe(true)

    await campaign.stop()

    expect(lost).toEqual([])
  })

  it('ends without leading when stopped while an attempt is on the wire', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newReplica(backend)
    fake()

    backend.late = ['acquire']
    const campaign = lock.campaign('scheduler')
    await vi.advanceTimersByTimeAsync(0)
    await campaign.stop()
    // The lease the backend granted arrives after the stop, and is handed back rather than led with.
    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(campaign.isLeader).toBe(false)
    expect(campaign.lock).toBeUndefined()
    expect(await backend.tryAcquire('scheduler', 1 * Second)).toBeDefined()
  })

  // A backoff that throws leaves no pause to wait: the campaign ends with a warning rather than spin or reject.
  it('ends with one warning when the backoff throws', async () => {
    const backend = new FaultyBackend()
    const log = new RecordingLogger()
    const { lock } = await newReplica(backend, d =>
      d.logger(log).backoff(() => {
        throw new Error('bad schedule')
      }),
    )
    fake()

    backend.failAcquire = true
    const campaign = lock.campaign('scheduler')
    await vi.advanceTimersByTimeAsync(0)
    backend.failAcquire = false
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(campaign.isLeader).toBe(false)
    expect(log.at('warn').filter(r => r.msg === 'lock campaign stopped: backoff failed')).toHaveLength(1)
    await expect(campaign.stop()).resolves.toBeUndefined()
  })

  it('stops campaigning when the given signal aborts, releasing leadership if held', async () => {
    const memory = new MemoryLockBackend()
    const { lock } = await newReplica(memory)
    fake()

    const controller = new AbortController()
    const campaign = lock.campaign('scheduler', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(campaign.isLeader).toBe(true)

    controller.abort()
    await campaign.stop()

    expect(campaign.isLeader).toBe(false)
    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeDefined()
    // Stopped for good: nothing campaigns for the key any more.
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(campaign.lock).toBeUndefined()
  })

  it('returns the same ending from every stop()', async () => {
    const { lock } = await newReplica(new MemoryLockBackend())

    const campaign = lock.campaign('scheduler')
    const first = campaign.stop()

    expect(campaign.stop()).toBe(first)
    await first
  })

  it('ends every campaign when the application closes, so another replica is elected within 1 s', async () => {
    const backend = new MemoryLockBackend()
    const [a, b] = [await newReplica(backend), await newReplica(backend)]
    fake()

    const leading = a.lock.campaign('scheduler')
    await vi.advanceTimersByTimeAsync(0)
    const waiting = b.lock.campaign('scheduler')
    await vi.advanceTimersByTimeAsync(0)
    expect(leading.isLeader).toBe(true)

    await a.close()
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(leading.isLeader).toBe(false)
    expect(waiting.isLeader).toBe(true)
  })

  // A closed service ends every lease it hands out, so campaigning on could only churn; the key is left to lapse, as
  // the service leaves every key it closed on.
  it('stops for good, leaving the key to lapse, when its lease is lost to the service closing', async () => {
    const memory = new MemoryLockBackend()
    const { lock, close } = await newReplica(memory)
    const lost: LostReason[] = []
    await close()
    fake()

    const campaign = lock.campaign('scheduler', { ttl: 3 * Second, onLost: reason => void lost.push(reason) })
    await vi.advanceTimersByTimeAsync(0)
    await campaign.stop()

    expect(lost).toEqual(['shutdown'])
    expect(campaign.isLeader).toBe(false)
    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3 * Second)
    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeDefined()
  })

  it('publishes elected, lost and stepped-down on the election channel, each once', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newReplica(backend)
    const published: Array<[ElectionMessage['event'], LostReason | undefined]> = []
    lock.events.on('election', message => published.push([message.event, message.reason]))
    fake()

    const campaign = lock.campaign('scheduler', { ttl: 3 * Second })
    await vi.advanceTimersByTimeAsync(0)

    backend.stolen = true
    await vi.advanceTimersByTimeAsync(1 * Second)
    backend.stolen = false
    // The key is still held by its lease in the inner backend; it frees once that lapses.
    await vi.advanceTimersByTimeAsync(3 * Second)
    expect(campaign.isLeader).toBe(true)

    await campaign.stop()

    expect(published).toEqual([
      ['elected', undefined],
      ['lost', 'taken'],
      ['elected', undefined],
      ['stepped-down', undefined],
    ])
  })

  // A backend outage is something to wait out, not a reason for the campaign to end.
  it('keeps campaigning through backend failures, and is elected once the backend answers', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newReplica(backend)
    fake()

    backend.failAcquire = true
    const campaign = lock.campaign('scheduler')
    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(campaign.isLeader).toBe(false)

    backend.failAcquire = false
    await vi.advanceTimersByTimeAsync(100 * Millisecond)

    expect(campaign.isLeader).toBe(true)
    await campaign.stop()
  })

  // A campaign started under a signal that already fired, such as a shutdown one, must not take the key even once.
  it('never campaigns when its signal had already aborted', async () => {
    const memory = new MemoryLockBackend()
    const { lock } = await newReplica(memory)
    fake()

    const campaign = lock.campaign('scheduler', { signal: AbortSignal.abort() })
    await vi.advanceTimersByTimeAsync(1 * Second)
    await campaign.done

    expect(campaign.lock).toBeUndefined()
    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeDefined()
  })

  // `await using` is how a scoped job campaigns: leaving the scope has to give leadership up, like stop().
  it('stops and releases leadership when disposed at the end of an await using scope', async () => {
    const memory = new MemoryLockBackend()
    const { lock } = await newReplica(memory)
    fake()

    {
      await using campaign = lock.campaign('scheduler')
      await vi.advanceTimersByTimeAsync(0)
      expect(campaign.isLeader).toBe(true)
    }

    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeDefined()
  })

  // A listener that stops the campaign as it is elected has decided before onElected could start work it would
  // then have to abandon.
  it('steps down without running onElected when an elected listener stops the campaign', async () => {
    const memory = new MemoryLockBackend()
    const { lock } = await newReplica(memory)
    const published: Array<ElectionMessage['event']> = []
    let ran = 0
    fake()

    const campaign = lock.campaign('scheduler', { onElected: () => void (ran += 1) })
    lock.events.on('election', message => {
      published.push(message.event)
      if (message.event === 'elected') {
        void campaign.stop()
      }
    })
    await campaign.done

    expect(ran).toBe(0)
    expect(published).toEqual(['elected', 'stepped-down'])
    expect(await memory.tryAcquire('scheduler', 1 * Second)).toBeDefined()
  })

  // A hook that throws on every loss is one bug, not one incident per loss; and the campaign must outlive it.
  it('warns once when onLost throws, and keeps campaigning', async () => {
    const backend = new FaultyBackend()
    const log = new RecordingLogger()
    const { lock } = await newReplica(backend, d => d.logger(log))
    fake()

    const campaign = lock.campaign('scheduler', {
      ttl: 3 * Second,
      onLost: () => {
        throw new Error('hook broke')
      },
    })
    for (let round = 0; round < 2; round++) {
      await vi.advanceTimersByTimeAsync(0)
      expect(campaign.isLeader).toBe(true)
      backend.stolen = true
      await vi.advanceTimersByTimeAsync(1 * Second)
      backend.stolen = false
      await vi.advanceTimersByTimeAsync(3 * Second)
    }

    expect(campaign.isLeader).toBe(true)
    expect(log.at('warn').filter(record => record.msg === 'lock campaign onLost failed')).toHaveLength(1)
    expect(log.at('debug').filter(record => record.msg === 'lock campaign onLost failed')).toHaveLength(1)
    await campaign.stop()
  })

  // A lease lost to a failing backend may still sit on the store under this token: handing it back, token-checked,
  // spares the next campaigner the rest of the lease once the store answers again.
  it('hands the key back when its lease is lost to a backend failure', async () => {
    const backend = new FaultyBackend()
    const lost: LostReason[] = []
    const { lock } = await newReplica(backend)
    fake()

    const campaign = lock.campaign('scheduler', { ttl: 3 * Second, onLost: reason => void lost.push(reason) })
    await vi.advanceTimersByTimeAsync(0)
    const held = campaign.lock!
    backend.failExtend = true
    await vi.advanceTimersByTimeAsync(3 * Second)

    expect(lost[0]).toBe('error')
    expect(backend.released.map(lease => lease.token)).toContain(held.token)
    await campaign.stop()
  })
})
