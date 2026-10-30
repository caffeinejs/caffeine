// What the breaker reads from a sliding window. Counters are kept running, so a read is a field load.
export interface Window {
  readonly total: number
  readonly failed: number
  readonly slow: number
  readonly slowFailed: number
  record(failed: boolean, slow: boolean, nowMs: number): void
  reset(): void
}

const FAILED = 1
const SLOW = 2

// The last `size` outcomes, one byte of flags each, in a ring.
export class CountWindow implements Window {
  total = 0
  failed = 0
  slow = 0
  slowFailed = 0
  readonly #flags: Uint8Array
  #head = 0

  constructor(size: number) {
    this.#flags = new Uint8Array(size)
  }

  record(failed: boolean, slow: boolean): void {
    const flags = this.#flags
    const head = this.#head

    if (this.total === flags.length) {
      const evicted = flags[head]
      this.total--
      if ((evicted & FAILED) !== 0) {
        this.failed--
      }
      if ((evicted & SLOW) !== 0) {
        this.slow--
        if ((evicted & FAILED) !== 0) {
          this.slowFailed--
        }
      }
    }

    flags[head] = (failed ? FAILED : 0) | (slow ? SLOW : 0)
    this.total++
    if (failed) {
      this.failed++
    }
    if (slow) {
      this.slow++
      if (failed) {
        this.slowFailed++
      }
    }

    this.#head = head + 1 === flags.length ? 0 : head + 1
  }

  reset(): void {
    this.#flags.fill(0)
    this.#head = 0
    this.total = 0
    this.failed = 0
    this.slow = 0
    this.slowFailed = 0
  }
}
