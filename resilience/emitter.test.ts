import { afterEach, describe, expect, it, vi } from 'vitest'

import { Emitter } from './emitter.js'

interface Events {
  tick: { n: number }
  tock: { n: number }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Emitter', () => {
  it('delivers an event to its listeners in the order they were added, and only to them', () => {
    const emitter = new Emitter<Events>()
    const seen: string[] = []
    emitter.on('tick', e => seen.push(`first:${e.n}`))
    emitter.on('tick', e => seen.push(`second:${e.n}`))
    emitter.on('tock', e => seen.push(`tock:${e.n}`))

    emitter.emit('tick', { n: 1 })

    expect(seen).toEqual(['first:1', 'second:1'])
  })

  // The count lets every call site skip its per-type lookup while nothing listens. A count that drifted below the
  // real number of listeners would silence the ones left.
  it('knows whether anything listens through additions, removals and repeated removals', () => {
    const emitter = new Emitter<Events>()
    const offTick = emitter.on('tick', () => undefined)
    const offTock = emitter.on('tock', () => undefined)
    expect([emitter.has('tick'), emitter.has('tock')]).toEqual([true, true])

    offTick()
    offTick()
    expect([emitter.has('tick'), emitter.has('tock')]).toEqual([false, true])

    offTock()
    expect([emitter.has('tick'), emitter.has('tock')]).toEqual([false, false])
  })

  // Call sites skip building the event object when nobody listens; `has` must be exact for that to be safe.
  it('reports whether a type has listeners, tracking additions and removals', () => {
    const emitter = new Emitter<Events>()
    expect(emitter.has('tick')).toBe(false)

    const off = emitter.on('tick', () => undefined)
    expect(emitter.has('tick')).toBe(true)
    expect(emitter.has('tock')).toBe(false)

    off()
    expect(emitter.has('tick')).toBe(false)
  })

  it('applies a removal made during an emit from the next emit on, without skipping or repeating a listener', () => {
    const emitter = new Emitter<Events>()
    const seen: string[] = []
    const offFirst = emitter.on('tick', () => {
      seen.push('first')
      offFirst()
    })
    emitter.on('tick', () => seen.push('second'))

    emitter.emit('tick', { n: 1 })
    emitter.emit('tick', { n: 2 })

    expect(seen).toEqual(['first', 'second', 'second'])
  })

  it('removes one registration per remover, even when called twice', () => {
    const emitter = new Emitter<Events>()
    let calls = 0
    const listener = (): void => {
      calls++
    }
    const off = emitter.on('tick', listener)
    emitter.on('tick', listener)

    off()
    off()
    emitter.emit('tick', { n: 1 })

    expect(calls).toBe(1)
  })

  // A broken metrics listener must never become the failure of the call being observed.
  it('keeps emitting after a listener throws and rethrows the error on a microtask', () => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    const emitter = new Emitter<Events>()
    const boom = new Error('boom')
    const seen: number[] = []
    emitter.on('tick', () => {
      throw boom
    })
    emitter.on('tick', e => seen.push(e.n))

    expect(() => emitter.emit('tick', { n: 1 })).not.toThrow()

    expect(seen).toEqual([1])
    expect(queued).toHaveLength(1)
    expect(() => queued[0]()).toThrow(boom)
  })

  it('rethrows a rejection returned by a listener on a microtask', async () => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    const emitter = new Emitter<Events>()
    const boom = new Error('boom')
    emitter.on('tick', () => Promise.reject(boom))

    emitter.emit('tick', { n: 1 })
    await Promise.resolve()
    await Promise.resolve()

    expect(queued).toHaveLength(1)
    expect(() => queued[0]()).toThrow(boom)
  })
})
