import type { SourceState } from './store.js'

/** How long a watched source stays quiet before it is reloaded: a burst of events becomes one reload. */
export const WATCH_DEBOUNCE_MS = 250

/** How long before a watcher that could not start is started again. Doubled per failure, up to 8 times. */
export const WATCH_RETRY_MS = 1_000

/**
 * The delay before the next poll: the interval, doubled per consecutive failure up to 8 times, with 10 percent of
 * jitter either way so that many processes polling one server spread apart.
 */
export function pollDelay(intervalMs: number, consecutiveFailures: number, random: () => number = Math.random): number {
  return pollBackoff(intervalMs, consecutiveFailures) * (0.9 + random() * 0.2)
}

/** The delay {@link pollDelay} centres on, without jitter. What a log reports as the next attempt. */
export function pollBackoff(intervalMs: number, consecutiveFailures: number): number {
  return intervalMs * Math.min(2 ** consecutiveFailures, 8)
}

/**
 * Arms the poll timers and the watchers of a set of sources, and disarms them.
 *
 * Every timer is unreferenced, so a trigger never keeps a process alive. A poll is scheduled when the previous
 * reload request settles, so two polls of one source never overlap. A watcher that cannot start is reported once
 * and started again, backing off as a failing poll does, and the source is reloaded once it starts.
 */
export class TriggerScheduler {
  readonly #request: (state: SourceState, trigger: 'poll' | 'watch') => Promise<unknown>
  readonly #onWatchError: (state: SourceState, error: unknown) => void
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #stops: (() => void)[] = []
  #stopped = false

  constructor(
    request: (state: SourceState, trigger: 'poll' | 'watch') => Promise<unknown>,
    onWatchError: (state: SourceState, error: unknown) => void,
  ) {
    this.#request = request
    this.#onWatchError = onWatchError
  }

  start(states: readonly SourceState[]): void {
    for (const state of states) {
      if (state.pollMs !== undefined) {
        this.#schedule(state)
      }
      if (state.source.watch !== undefined) {
        this.#watch(state)
      }
    }
  }

  stop(): void {
    this.#stopped = true

    for (const timer of this.#timers) {
      clearTimeout(timer)
    }
    this.#timers.clear()

    for (const stop of this.#stops.splice(0)) {
      try {
        stop()
      } catch {
        // A watcher that cannot stop cleanly has nothing left to tell us.
      }
    }
  }

  #schedule(state: SourceState): void {
    if (this.#stopped) {
      return
    }

    this.#after(pollDelay(state.pollMs!, state.consecutiveFailures), () => {
      void this.#request(state, 'poll').finally(() => this.#schedule(state))
    })
  }

  #watch(state: SourceState, failures = 0): void {
    if (this.#stopped) {
      return
    }

    let debounce: ReturnType<typeof setTimeout> | undefined

    const changed = (): void => {
      if (this.#stopped) {
        return
      }
      if (debounce !== undefined) {
        clearTimeout(debounce)
        this.#timers.delete(debounce)
      }

      debounce = this.#after(WATCH_DEBOUNCE_MS, () => {
        debounce = undefined
        void this.#request(state, 'watch')
      })
    }

    try {
      this.#stops.push(state.source.watch!(changed))
    } catch (error) {
      // What is watched may not exist yet, such as a directory mounted after start-up, so this is not the end of it.
      if (failures === 0) {
        this.#onWatchError(state, error)
      }
      this.#after(pollDelay(WATCH_RETRY_MS, failures), () => this.#watch(state, failures + 1))
      return
    }

    if (failures > 0) {
      // Nothing reported what changed while nothing was watching.
      void this.#request(state, 'watch')
    }
  }

  /** Runs `run` after `ms`, on an unreferenced timer that {@link stop} clears. */
  #after(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, ms)

    timer.unref?.()
    this.#timers.add(timer)
    return timer
  }
}
