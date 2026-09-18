import { describe, expect, it } from 'vitest'

import { TimeWindow } from './_time_window.js'

function counters(window: TimeWindow): [number, number, number, number] {
  return [window.total, window.failed, window.slow, window.slowFailed]
}

describe('TimeWindow', () => {
  it('counts every outcome recorded within the window', () => {
    const window = new TimeWindow(3)

    window.record(true, false, 1_000)
    window.record(false, true, 1_500)
    window.record(true, true, 2_900)

    expect(counters(window)).toEqual([3, 2, 2, 1])
  })

  // "The last N seconds" must mean it: a failure from long ago says nothing about the dependency now.
  it('drops the outcomes of a second once it leaves the window', () => {
    const window = new TimeWindow(3)
    window.record(true, true, 1_000)
    window.record(false, false, 2_000)
    window.record(true, false, 3_000)

    window.record(false, false, 4_000)
    expect(counters(window)).toEqual([3, 1, 0, 0])

    window.record(false, false, 6_000)
    expect(counters(window)).toEqual([2, 0, 0, 0])
  })

  it('clears everything after an idle gap at least as long as the window', () => {
    const window = new TimeWindow(3)
    window.record(true, true, 1_000)
    window.record(true, true, 2_000)

    window.record(false, false, 60_000)

    expect(counters(window)).toEqual([1, 0, 0, 0])
  })

  it('keeps counting in the same bucket within one second', () => {
    const window = new TimeWindow(1)

    window.record(true, false, 10_000)
    window.record(true, false, 10_999)
    expect(counters(window)).toEqual([2, 2, 0, 0])

    window.record(false, false, 11_000)
    expect(counters(window)).toEqual([1, 0, 0, 0])
  })

  it('starts over after reset', () => {
    const window = new TimeWindow(5)
    window.record(true, true, 1_000)

    window.reset()
    window.record(false, false, 1_000)

    expect(counters(window)).toEqual([1, 0, 0, 0])
  })

  // A reader must see the window as it is now, even when nothing has been recorded since.
  it('drops outcomes that left the window when it is advanced without a record', () => {
    const window = new TimeWindow(2)
    window.record(true, false, 0)

    window.advance(5_000)

    expect(counters(window)).toEqual([0, 0, 0, 0])
  })
})
