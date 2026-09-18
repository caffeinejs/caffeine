import type { Window } from './_count_window.js'

// The outcomes of the last `seconds` seconds, one bucket per second in a ring. Seconds are counted on the
// monotonic clock the caller passes in. The window moves when something is recorded and when the breaker reads it,
// so a read after an idle gap no longer reports outcomes that left the window.
export class TimeWindow implements Window {
  total = 0
  failed = 0
  slow = 0
  slowFailed = 0
  readonly #totals: Uint32Array
  readonly #faileds: Uint32Array
  readonly #slows: Uint32Array
  readonly #slowFaileds: Uint32Array
  #head = 0
  #second = -1

  constructor(seconds: number) {
    this.#totals = new Uint32Array(seconds)
    this.#faileds = new Uint32Array(seconds)
    this.#slows = new Uint32Array(seconds)
    this.#slowFaileds = new Uint32Array(seconds)
  }

  record(failed: boolean, slow: boolean, nowMs: number): void {
    this.advance(nowMs)

    const head = this.#head
    this.#totals[head]++
    this.total++
    if (failed) {
      this.#faileds[head]++
      this.failed++
    }
    if (slow) {
      this.#slows[head]++
      this.slow++
      if (failed) {
        this.#slowFaileds[head]++
        this.slowFailed++
      }
    }
  }

  reset(): void {
    this.#totals.fill(0)
    this.#faileds.fill(0)
    this.#slows.fill(0)
    this.#slowFaileds.fill(0)
    this.#head = 0
    this.#second = -1
    this.total = 0
    this.failed = 0
    this.slow = 0
    this.slowFailed = 0
  }

  // Moves the window to the second `nowMs` falls in. A second that already passed counts as the current one.
  advance(nowMs: number): void {
    const second = Math.floor(nowMs / 1000)
    if (this.#second === -1) {
      this.#second = second
      return
    }

    let elapsed = second - this.#second
    if (elapsed <= 0) {
      return
    }

    const size = this.#totals.length
    if (elapsed >= size) {
      this.reset()
      this.#second = second
      return
    }

    while (elapsed-- > 0) {
      const head = this.#head + 1 === size ? 0 : this.#head + 1
      this.total -= this.#totals[head]
      this.failed -= this.#faileds[head]
      this.slow -= this.#slows[head]
      this.slowFailed -= this.#slowFaileds[head]
      this.#totals[head] = 0
      this.#faileds[head] = 0
      this.#slows[head] = 0
      this.#slowFaileds[head] = 0
      this.#head = head
    }

    this.#second = second
  }
}
