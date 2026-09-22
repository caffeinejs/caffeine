/** How a leader's flight ended: its response was stored, a stale entry was served in its place, or neither. */
export type FlightOutcome = 'stored' | 'rescued' | 'not-stored'

/** The flights of one install, by store key. */
export type FlightTable = Map<string, Flight>

/**
 * One handler run that concurrent misses for the same key wait on.
 *
 * The leader settles it from its store hook. The timer is the settlement for a leader whose store hook never
 * runs — a hijacked reply, a handler that never returns — and bounds every follower at once: followers hold no
 * timer of their own. Settling is first-wins, and a flight only ever removes itself from the table, never a
 * newer flight under the same key.
 */
export class Flight {
  readonly done: Promise<FlightOutcome>
  readonly #table: FlightTable
  readonly #key: string
  readonly #timer: NodeJS.Timeout
  #resolve!: (outcome: FlightOutcome) => void

  constructor(table: FlightTable, key: string, ms: number) {
    this.#table = table
    this.#key = key
    this.done = new Promise<FlightOutcome>(resolve => {
      this.#resolve = resolve
    })
    this.#timer = setTimeout(() => this.settle('not-stored'), ms)
    this.#timer.unref()
    table.set(key, this)
  }

  settle(outcome: FlightOutcome): void {
    clearTimeout(this.#timer)
    if (this.#table.get(this.#key) === this) {
      this.#table.delete(this.#key)
    }
    this.#resolve(outcome)
  }
}
