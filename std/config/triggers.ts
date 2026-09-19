import type { ConfigSource } from './types.js'

/** How long a watched source stays quiet before it is reloaded: a burst of events becomes one reload. */
export const WATCH_DEBOUNCE_MS = 250

/** What the scheduler needs to know about one source. */
export interface Triggered {
  readonly source: ConfigSource
  /** The poll period, or `undefined` when the source is not polled. */
  readonly pollMs: number | undefined
  readonly consecutiveFailures: number
}

/**
 * The delay before the next poll: the interval, doubled per consecutive failure up to 8 times, with 10 percent of
 * jitter either way so that many processes polling one server spread apart.
 */
export function pollDelay(intervalMs: number, consecutiveFailures: number, random: () => number = Math.random): number {
  return intervalMs * Math.min(2 ** consecutiveFailures, 8) * (0.9 + random() * 0.2)
}

/** The delay {@link pollDelay} centres on, without jitter. What a log reports as the next attempt. */
export function pollBackoff(intervalMs: number, consecutiveFailures: number): number {
  return intervalMs * Math.min(2 ** consecutiveFailures, 8)
}

/**
 * Arms the poll timers and the watchers of a set of sources, and disarms them.
 *
 * Every timer is unreferenced, so a trigger never keeps a process alive. A poll is scheduled when the previous
 * reload request settles, so two polls of one source never overlap.
 */
export class TriggerScheduler<S extends Triggered> {
  readonly #request: (state: S, trigger: 'poll' | 'watch') => Promise<unknown>
  readonly #onWatchError: (state: S, error: unknown) => void
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #stops: (() => void)[] = []
  #stopped = false

  constructor(
    request: (state: S, trigger: 'poll' | 'watch') => Promise<unknown>,
    onWatchError: (state: S, error: unknown) => void,
  ) {
    this.#request = request
    this.#onWatchError = onWatchError
  }

  start(states: readonly S[]): void {
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

  #schedule(state: S): void {
    if (this.#stopped) {
      return
    }

    const timer = setTimeout(
      () => {
        this.#timers.delete(timer)
        void this.#request(state, 'poll').finally(() => this.#schedule(state))
      },
      pollDelay(state.pollMs!, state.consecutiveFailures),
    )

    timer.unref?.()
    this.#timers.add(timer)
  }

  #watch(state: S): void {
    let debounce: ReturnType<typeof setTimeout> | undefined

    const changed = (): void => {
      if (this.#stopped) {
        return
      }
      if (debounce !== undefined) {
        clearTimeout(debounce)
        this.#timers.delete(debounce)
      }

      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        debounce = undefined
        void this.#request(state, 'watch')
      }, WATCH_DEBOUNCE_MS)

      timer.unref?.()
      this.#timers.add(timer)
      debounce = timer
    }

    try {
      this.#stops.push(state.source.watch!(changed))
    } catch (error) {
      this.#onWatchError(state, error)
    }
  }
}
