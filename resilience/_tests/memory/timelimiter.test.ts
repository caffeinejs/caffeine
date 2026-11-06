import { getHeapSpaceStatistics } from 'node:v8'

import { Second } from '@caffeinejs/std/duration'
import { describe, expect, it } from 'vitest'

import { decorate } from '../../compose.js'
import { timeLimiter } from '../../timelimiter/timelimiter.js'

// Finalizers run on a later turn than the collection that queues them, and a few collections may be needed.
async function collect(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    globalThis.gc!()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

// The old space once collected: what a call leaves behind ends up there. The large-object space is left out, because
// the test runner allocates buffers of a few megabytes there between two readings.
async function retained(): Promise<number> {
  await collect()
  return getHeapSpaceStatistics().find(space => space.space_name === 'old_space')!.space_used_size
}

// Node 22 keeps an entry on the source signal for every signal combined from it, and drops none of them.
const major = Number(process.versions.node.split('.')[0])

// A caller signal can outlive every call it is passed to, as a shutdown signal does. The time limiter combines it
// with its own on every call: what each call combined must go once the call settles, or a long-lived worker grows
// until it dies.
describe.skipIf(major < 24)('a time limiter called with one long-lived signal', () => {
  it('leaves nothing behind per call once the calls settle', async () => {
    const shutdown = new AbortController().signal
    const fetchStock = decorate(
      timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second }),
      async (_: string, signal: AbortSignal) => !signal.aborted,
    )
    const batch = async (): Promise<void> => {
      for (let i = 0; i < 100_000; i++) {
        await fetchStock('42', shutdown)
      }
    }

    await batch()
    const before = await retained()
    await batch()
    const grown = (await retained()) - before

    // Even 16 bytes left per call would grow it by 1.6 MB.
    expect(grown).toBeLessThan(1024 * 1024)
  })

  it('lets every signal it handed the operation be collected while the caller lives', async () => {
    const shutdown = new AbortController().signal
    const handed: WeakRef<AbortSignal>[] = []
    const fetchStock = decorate(
      timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second }),
      async (_: string, signal: AbortSignal) => {
        handed.push(new WeakRef(signal))
        return true
      },
    )

    for (let i = 0; i < 1_000; i++) {
      await fetchStock('42', shutdown)
    }
    await collect()

    expect(handed).toHaveLength(1_000)
    expect(handed.filter(ref => ref.deref() !== undefined)).toEqual([])
  })
})
