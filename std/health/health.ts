import type { ApplicationAvailability } from './availability.js'
import type { HealthGroup } from './indicator.js'
import type { GroupOutcome, HealthRegistry, IndicatorOutcome } from './registry.js'

/** One line of a probe's own state — boot, traffic, liveness — evaluated before any indicator runs. */
export interface ProbeCheck {
  name: string
  ok: boolean
  detail?: string
}

/** A probe's verdict, and the checks and indicator outcomes it was reached from. */
export interface ProbeResult {
  ok: boolean
  checks: readonly ProbeCheck[]
  outcomes: readonly IndicatorOutcome[]
}

export interface ProbeOptions {
  /**
   * Names of indicators to skip. A filtered result is never cached or shared, so every call that excludes runs its
   * own evaluation against the dependencies.
   */
  exclude?: readonly string[]
}

/**
 * The application's liveness, readiness and startup verdicts, from its {@link ApplicationAvailability} and the
 * `HealthIndicator`s bound in its container.
 *
 * Every application binds one, headless included, whether or not anything exposes it: `health()` from
 * `@caffeinejs/http` serves its HTTP probes from it, and anything else — a Watt readiness check, a custom route, a
 * test — injects the same instance, so all of them share one evaluation per group. Resolve it once `ready()` has
 * run.
 *
 * Readiness and startup stay failing until the application runs: `run()` is what marks it started and accepting.
 * An application served by something else — a host that listens on its instance instead of calling `run()` —
 * marks that itself with `app.availability.markStarted().acceptTraffic()`.
 *
 * No method rejects. An indicator that throws or overruns its budget is reported `down`.
 */
export class ApplicationHealth {
  readonly #availability: ApplicationAvailability
  readonly #registry: HealthRegistry

  constructor(availability: ApplicationAvailability, registry: HealthRegistry) {
    this.#availability = availability
    this.#registry = registry
  }

  /**
   * Liveness. Being able to answer is itself most of the answer: the event loop is turning and the process is not
   * deadlocked, which is the entire question the orchestrator is asking. It fails only on an explicit
   * `markBroken()` or on an indicator a user deliberately placed in the `liveness` group.
   *
   * Nothing here touches a dependency. A liveness probe that can fail because a database blinked converts a
   * dependency outage into a restart storm.
   */
  async liveness(options: ProbeOptions = {}): Promise<ProbeResult> {
    const availability = this.#availability
    const checks: ProbeCheck[] = [
      { name: 'live', ok: availability.live === 'correct', detail: availability.livenessReason },
    ]

    const outcome = availability.live === 'correct' ? await this.#evaluate('liveness', options) : undefined

    return result(checks, outcome)
  }

  /**
   * Readiness. Fails while booting, while draining, and when a critical indicator is down. The state checks come
   * first so a draining process answers without touching a single dependency.
   */
  async readiness(options: ProbeOptions = {}): Promise<ProbeResult> {
    const availability = this.#availability
    const checks: ProbeCheck[] = [
      { name: 'started', ok: availability.started, detail: availability.started ? undefined : 'starting' },
      { name: 'accepting', ok: availability.ready === 'accepting', detail: availability.readinessReason },
      { name: 'live', ok: availability.live === 'correct', detail: availability.livenessReason },
    ]

    const outcome = checks.every(check => check.ok) ? await this.#evaluate('readiness', options) : undefined

    return result(checks, outcome)
  }

  /** Startup. Passes once boot completed, so a slow boot never gets the container killed mid-initialization. */
  async startup(options: ProbeOptions = {}): Promise<ProbeResult> {
    const availability = this.#availability
    const checks: ProbeCheck[] = [
      { name: 'started', ok: availability.started, detail: availability.started ? undefined : 'starting' },
    ]

    const outcome = availability.started ? await this.#evaluate('startup', options) : undefined

    return result(checks, outcome)
  }

  #evaluate(group: HealthGroup, options: ProbeOptions): Promise<GroupOutcome> | undefined {
    if (!this.#registry.has(group)) {
      return undefined
    }

    return this.#registry.evaluate(group, options.exclude === undefined ? undefined : new Set(options.exclude))
  }
}

function result(checks: readonly ProbeCheck[], outcome: GroupOutcome | undefined): ProbeResult {
  return {
    ok: checks.every(check => check.ok) && (outcome?.ok ?? true),
    checks,
    outcomes: outcome?.outcomes ?? [],
  }
}
