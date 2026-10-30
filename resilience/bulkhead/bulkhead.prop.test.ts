import { Millisecond } from '@caffeinejs/std/duration'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

import { runWith } from '../compose.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { bulkhead } from './bulkhead.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const call = fc.record({
  arriveAt: fc.integer({ min: 0, max: 500 }),
  duration: fc.integer({ min: 0, max: 300 }),
  abortAt: fc.option(fc.integer({ min: 0, max: 800 }), { nil: undefined }),
})

describe('bulkhead (property)', () => {
  // Whatever the order calls arrive, finish and give up in, the bulkhead must never run more than its limit, never
  // hold a longer line than its limit, start a call at once when a slot is free, refuse one only when it is full,
  // let waiting calls in the order they queued, settle every call exactly once, and end with every slot free.
  it.prop([
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 0, max: 4 }),
    fc.integer({ min: 0, max: 300 }),
    fc.array(call, { minLength: 1, maxLength: 30 }),
  ])(
    'keeps its limits and its order, and frees every slot',
    async (maxConcurrentCalls, maxQueuedCalls, maxWait, calls) => {
      vi.clearAllTimers()
      const pool = bulkhead({
        name: 'payments',
        maxConcurrentCalls,
        maxQueuedCalls,
        maxWaitDuration: maxWait * Millisecond,
      })
      let running = 0
      let peak = 0
      let longestLine = 0
      const violations: string[] = []
      const settledTimes = calls.map(() => 0)
      const queuedOrder: number[] = []
      const startedFromLine: number[] = []

      for (const [i, { arriveAt, duration, abortAt }] of calls.entries()) {
        const controller = new AbortController()
        if (abortAt !== undefined) {
          setTimeout(() => controller.abort(new Error('gave up')), abortAt)
        }
        setTimeout(() => {
          const settle = () => {
            settledTimes[i]!++
          }
          const before = pool.metrics()
          const runningBefore = running
          let queued = false
          runWith(
            () => {
              if (queued) {
                startedFromLine.push(i)
              }
              running++
              peak = Math.max(peak, running)
              return new Promise<void>(resolve =>
                setTimeout(() => {
                  running--
                  resolve()
                }, duration),
              )
            },
            pool,
            controller.signal,
          ).then(settle, settle)

          const after = pool.metrics()
          const startedAtOnce = running === runningBefore + 1
          const refusedAtOnce = after.rejectedCalls === before.rejectedCalls + 1
          queued = after.queuedCalls === before.queuedCalls + 1
          if (queued) {
            queuedOrder.push(i)
          }
          if (!controller.signal.aborted) {
            if (before.availableConcurrentCalls > 0 && !startedAtOnce) {
              violations.push(`call ${i} found a free slot and did not start`)
            }
            if (
              refusedAtOnce &&
              (before.availableConcurrentCalls > 0 || (maxWait > 0 && before.queuedCalls < maxQueuedCalls))
            ) {
              violations.push(`call ${i} was refused with room to run or wait`)
            }
          }
          longestLine = Math.max(longestLine, after.queuedCalls)
        }, arriveAt)
      }

      await vi.advanceTimersByTimeAsync(2_000)

      expect(violations).toEqual([])
      expect(peak).toBeLessThanOrEqual(maxConcurrentCalls)
      expect(longestLine).toBeLessThanOrEqual(maxWait === 0 ? 0 : maxQueuedCalls)
      expect(startedFromLine).toEqual(queuedOrder.filter(i => startedFromLine.includes(i)))
      expect(settledTimes.every(times => times === 1)).toBe(true)
      expect(running).toBe(0)
      expect(pool.metrics()).toMatchObject({ availableConcurrentCalls: maxConcurrentCalls, queuedCalls: 0 })
    },
  )
})
