import { describe, expect, it } from 'vitest'

import { CountWindow } from './_count_window.js'

function counters(window: CountWindow): [number, number, number, number] {
  return [window.total, window.failed, window.slow, window.slowFailed]
}

describe('CountWindow', () => {
  it('counts outcomes until the window is full', () => {
    const window = new CountWindow(4)

    window.record(true, false)
    window.record(false, true)
    window.record(true, true)

    expect(counters(window)).toEqual([3, 2, 2, 1])
  })

  // The breaker judges the last N calls; an old failure that stayed counted would keep it open forever.
  it('evicts the oldest outcome, with every flag it carried, once full', () => {
    const window = new CountWindow(3)
    window.record(true, true)
    window.record(false, false)
    window.record(false, true)

    window.record(false, false)
    expect(counters(window)).toEqual([3, 0, 1, 0])

    window.record(false, false)
    window.record(false, false)
    expect(counters(window)).toEqual([3, 0, 0, 0])
  })

  it('starts over after reset, evicting nothing recorded before it', () => {
    const window = new CountWindow(2)
    window.record(true, true)
    window.record(true, true)

    window.reset()
    window.record(false, false)
    window.record(true, false)
    window.record(false, false)

    expect(counters(window)).toEqual([2, 1, 0, 0])
  })
})
