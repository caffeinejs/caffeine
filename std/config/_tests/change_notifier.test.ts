import { describe, expect, it, vi } from 'vitest'

import { ChangeNotifier } from '../change_notifier.js'
import type { ConfigChange } from '../types.js'

let revision = 0

function publish<V>(notifier: ChangeNotifier<V>, value: V, changed: string[] = ['port']): void {
  const change: ConfigChange = { revision: ++revision, changed }
  notifier.record(value, change)
  notifier.flush()
}

describe('ChangeNotifier', () => {
  it('says nothing about the value it was constructed with', async () => {
    const notifier = new ChangeNotifier(1, vi.fn())
    const seen = vi.fn()
    notifier.add(seen)

    notifier.flush()
    await notifier.settled()

    expect(seen).not.toHaveBeenCalled()
  })

  it('delivers the new value, the previous one, and the change', async () => {
    const notifier = new ChangeNotifier(1, vi.fn())
    const seen = vi.fn()
    notifier.add(seen)

    publish(notifier, 2, ['server.port'])
    await notifier.settled()

    expect(seen).toHaveBeenCalledWith(2, 1, expect.objectContaining({ changed: ['server.port'] }))
  })

  it('says nothing when the recorded value is the one delivered last', async () => {
    const notifier = new ChangeNotifier(1, vi.fn())
    const seen = vi.fn()
    notifier.add(seen)

    publish(notifier, 1)
    await notifier.settled()

    expect(seen).not.toHaveBeenCalled()
  })

  it('tells a late subscriber about changes from then on, not before', async () => {
    const notifier = new ChangeNotifier(1, vi.fn())
    publish(notifier, 2)

    const seen = vi.fn()
    notifier.add(seen)
    publish(notifier, 3)
    await notifier.settled()

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(3, 2, expect.anything())
  })

  it('stops delivering once unsubscribed, or once cleared', async () => {
    const notifier = new ChangeNotifier(1, vi.fn())
    const removed = vi.fn()
    const cleared = vi.fn()
    notifier.add(removed)()
    notifier.add(cleared)
    notifier.clear()

    publish(notifier, 2)
    await notifier.settled()

    expect(removed).not.toHaveBeenCalled()
    expect(cleared).not.toHaveBeenCalled()
  })
})

describe('ChangeNotifier delivery', () => {
  // What a feature does about new configuration is its own business; a slow reaction must not hold up the reload.
  it('returns from flush without waiting for the listener', async () => {
    const notifier = new ChangeNotifier(0, vi.fn())
    let release: (() => void) | undefined
    let finished = false

    notifier.add(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      finished = true
    })

    publish(notifier, 1)
    await Promise.resolve()
    expect(finished).toBe(false)

    const settled = notifier.settled()
    await vi.waitFor(() => expect(release).toBeDefined())
    release?.()
    await settled

    expect(finished).toBe(true)
  })

  // Overlapping deliveries could finish out of order and leave the older value applied.
  it('never runs a listener concurrently with itself', async () => {
    const notifier = new ChangeNotifier(0, vi.fn())
    let inFlight = 0
    let overlapped = false

    notifier.add(async () => {
      inFlight++
      overlapped ||= inFlight > 1
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
    })

    publish(notifier, 1)
    publish(notifier, 2)
    await notifier.settled()

    expect(overlapped).toBe(false)
  })

  it('collapses a burst into the newest value rather than a backlog', async () => {
    const notifier = new ChangeNotifier(0, vi.fn())
    const seen: number[] = []
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })

    notifier.add(async value => {
      seen.push(value)
      if (seen.length === 1) {
        await blocked
      }
    })

    publish(notifier, 1)
    await vi.waitFor(() => expect(seen).toEqual([1]))
    for (const value of [2, 3, 4]) {
      publish(notifier, value)
    }

    release?.()
    await notifier.settled()

    expect(seen).toEqual([1, 4])
  })

  it('gives a coalesced delivery the last value delivered as its previous, and every path it stands for', async () => {
    const notifier = new ChangeNotifier(0, vi.fn())
    const seen: [number, number, readonly string[]][] = []
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })

    notifier.add(async (value, previous, change) => {
      seen.push([value, previous, change.changed])
      if (seen.length === 1) {
        await blocked
      }
    })

    publish(notifier, 1, ['a'])
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    publish(notifier, 2, ['b'])
    publish(notifier, 3, ['c', 'b'])

    release?.()
    await notifier.settled()

    expect(seen).toEqual([
      [1, 0, ['a']],
      [3, 1, ['b', 'c']],
    ])
  })
})

describe('ChangeNotifier failures', () => {
  it('reports a throwing listener and keeps the others running', async () => {
    const onError = vi.fn()
    const notifier = new ChangeNotifier(0, onError)
    const after = vi.fn()

    notifier.add(() => {
      throw new Error('bad reaction')
    })
    notifier.add(after)

    publish(notifier, 1)
    await notifier.settled()

    expect(after).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'bad reaction' }))
  })

  it('reports a rejecting listener rather than leaving an unhandled rejection', async () => {
    const onError = vi.fn()
    const notifier = new ChangeNotifier(0, onError)

    notifier.add(() => Promise.reject(new Error('async trouble')))

    publish(notifier, 1)
    await notifier.settled()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'async trouble' }))
  })

  it('keeps delivering to a listener that failed once', async () => {
    const notifier = new ChangeNotifier(0, vi.fn())
    const seen: number[] = []

    notifier.add(value => {
      seen.push(value)
      if (seen.length === 1) {
        throw new Error('first one went badly')
      }
    })

    publish(notifier, 1)
    await notifier.settled()
    publish(notifier, 2)
    await notifier.settled()

    expect(seen).toEqual([1, 2])
  })
})
