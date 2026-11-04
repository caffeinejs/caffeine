import { describe, expect, it, vi } from 'vitest'

import { linked } from '../../abort.js'

// Finalizers run on a later turn than the collection that queues them, and a few collections may be needed.
async function collect(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    globalThis.gc!()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

// A caller signal can outlive every call it is passed to, as a shutdown signal does: a linked signal nothing holds
// any more must neither stay alive nor keep a listener on it.
describe('a linked signal nothing holds', () => {
  const calls = 100

  it('is collected while the caller lives, and its listener leaves the caller', async () => {
    const caller = new AbortController()
    const removed = vi.spyOn(caller.signal, 'removeEventListener')
    const refs: WeakRef<AbortSignal>[] = []

    for (let i = 0; i < calls; i++) {
      refs.push(new WeakRef(linked(caller.signal, new AbortController().signal)))
    }
    await collect()

    expect(refs.filter(ref => ref.deref() !== undefined)).toHaveLength(0)
    expect(removed).toHaveBeenCalledTimes(calls)
  })

  it('is collected after the caller aborted', async () => {
    const caller = new AbortController()
    const refs: WeakRef<AbortSignal>[] = []

    for (let i = 0; i < calls; i++) {
      refs.push(new WeakRef(linked(caller.signal, new AbortController().signal)))
    }
    caller.abort()
    await collect()

    expect(refs.filter(ref => ref.deref() !== undefined)).toHaveLength(0)
  })
})
