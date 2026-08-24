/** Whether the process is functioning. `broken` tells the orchestrator to restart the container. */
export type LivenessState = 'correct' | 'broken'

/** Whether the process should receive traffic. `refusing` tells the orchestrator to remove it from routing. */
export type ReadinessState = 'accepting' | 'refusing'

/**
 * The application's availability, as the orchestrator understands it: two independent states plus the boot and
 * drain flags. Probes only **read** it; the application lifecycle and explicit user calls are the only writers.
 *
 * The separation is the point. A dependency failure must move {@link ready}, never {@link live} — a `broken`
 * liveness state gets the container killed, and killing a process because its database blinked turns a dependency
 * outage into a restart storm. Nothing in the health-indicator path can reach the liveness state.
 *
 * Lifecycle, in order:
 *
 * | Phase | live | ready | started | draining |
 * | --- | --- | --- | --- | --- |
 * | constructed | `correct` | `refusing` | `false` | `false` |
 * | after `run()` | `correct` | `accepting` | `true` | `false` |
 * | shutting down | `correct` | `refusing` | `true` | `true` |
 * | closed | `broken` | `refusing` | `true` | `true` |
 */
export class ApplicationAvailability {
  #live: LivenessState = 'correct'
  #ready: ReadinessState = 'refusing'
  #started = false
  #draining = false
  #livenessReason: string | undefined
  #readinessReason: string | undefined = 'starting'

  get live(): LivenessState {
    return this.#live
  }

  get ready(): ReadinessState {
    return this.#ready
  }

  /** Whether boot completed. Backs the startup probe. */
  get started(): boolean {
    return this.#started
  }

  /** Whether shutdown began. Once set, it never clears — a draining process never returns to `accepting`. */
  get draining(): boolean {
    return this.#draining
  }

  /** Why liveness is `broken`, when it is. */
  get livenessReason(): string | undefined {
    return this.#livenessReason
  }

  /** Why readiness is `refusing`, when it is. */
  get readinessReason(): string | undefined {
    return this.#readinessReason
  }

  /** Marks boot complete. The startup probe passes from here on. */
  markStarted(): this {
    this.#started = true
    return this
  }

  /** Starts accepting traffic. Ignored once {@link draining} — shutdown is one-way. */
  acceptTraffic(): this {
    if (this.#draining) {
      return this
    }

    this.#ready = 'accepting'
    this.#readinessReason = undefined
    return this
  }

  /** Stops accepting traffic without draining, e.g. while a required dependency is being re-established. */
  refuseTraffic(reason: string): this {
    this.#ready = 'refusing'
    this.#readinessReason = reason
    return this
  }

  /** Enters shutdown: readiness refuses immediately and permanently, liveness stays `correct`. */
  beginDrain(reason: string = 'shutdown'): this {
    this.#draining = true
    return this.refuseTraffic(reason)
  }

  /** Declares the process unrecoverable. The orchestrator restarts the container. Use sparingly. */
  markBroken(reason: string): this {
    this.#live = 'broken'
    this.#livenessReason = reason
    return this
  }

  /** Clears a previous {@link markBroken}. */
  markCorrect(): this {
    this.#live = 'correct'
    this.#livenessReason = undefined
    return this
  }
}
