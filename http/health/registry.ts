import { type HealthGroup, type HealthIndicator, type HealthReport, type HealthStatus } from '@caffeinejs/std'

/** One indicator's outcome for a single evaluation. */
export interface IndicatorOutcome {
  name: string
  status: HealthStatus
  critical: boolean
  detail?: string
  data?: Record<string, unknown>
  durationMs: number
}

/** The aggregate verdict for one probe group. */
export interface GroupOutcome {
  /** Whether the probe passes: no critical indicator reported `down`. */
  ok: boolean
  /** Whether something failed without failing the probe. */
  degraded: boolean
  outcomes: readonly IndicatorOutcome[]
}

export interface HealthRegistryOptions {
  indicatorTimeoutMs: number
  probeDeadlineMs: number
  cacheTTLMs: number
}

interface CacheEntry {
  at: number
  outcome: GroupOutcome
}

const EMPTY_OUTCOME: GroupOutcome = { ok: true, degraded: false, outcomes: [] }

/**
 * Runs the {@link HealthIndicator}s of one probe group under a bounded budget.
 *
 * Three properties the probe contract depends on, none of which come for free:
 *
 * - **It always answers.** An indicator that ignores its {@link AbortSignal} is raced against the deadline and
 *   reported `down`, rather than holding the response open until the kubelet's own timeout fires.
 * - **It coalesces.** Concurrent probes share one evaluation, so N in-flight requests are never N dependency calls.
 * - **It caches.** Within `cacheTTLMs` an evaluation is reused, which is what keeps
 *   `replicas × probeInterval` from turning into that many queries per second against a shared dependency.
 *
 * Caching and coalescing are skipped when the caller excludes indicators, since exclusions change the answer.
 */
export class HealthRegistry {
  readonly #byGroup = new Map<HealthGroup, HealthIndicator[]>()
  readonly #cache = new Map<HealthGroup, CacheEntry>()
  readonly #inflight = new Map<HealthGroup, Promise<GroupOutcome>>()
  readonly #options: HealthRegistryOptions

  constructor(indicators: readonly HealthIndicator[], options: HealthRegistryOptions) {
    this.#options = options

    for (const indicator of indicators) {
      for (const group of indicator.groups) {
        const list = this.#byGroup.get(group)
        if (list === undefined) {
          this.#byGroup.set(group, [indicator])
        } else {
          list.push(indicator)
        }
      }
    }
  }

  /** The indicators registered for a group, in registration order. */
  indicatorsOf(group: HealthGroup): readonly HealthIndicator[] {
    return this.#byGroup.get(group) ?? []
  }

  /** Whether any indicator contributes to a group. */
  has(group: HealthGroup): boolean {
    return this.#byGroup.has(group)
  }

  /** Drops every cached evaluation. Called when the application state changes underneath the cache. */
  invalidate(): void {
    this.#cache.clear()
  }

  /**
   * Evaluates a group, reusing a cached or in-flight evaluation when possible. `exclude` names indicators to skip
   * and bypasses both, because a filtered result must never be served to an unfiltered caller.
   */
  evaluate(group: HealthGroup, exclude?: ReadonlySet<string>): Promise<GroupOutcome> {
    const indicators = this.#byGroup.get(group)
    if (indicators === undefined) {
      return Promise.resolve(EMPTY_OUTCOME)
    }

    if (exclude !== undefined && exclude.size > 0) {
      return this.#evaluate(indicators.filter(indicator => !exclude.has(indicator.name)))
    }

    const cached = this.#cache.get(group)
    if (cached !== undefined && Date.now() - cached.at < this.#options.cacheTTLMs) {
      return Promise.resolve(cached.outcome)
    }

    const inflight = this.#inflight.get(group)
    if (inflight !== undefined) {
      return inflight
    }

    const evaluation = this.#evaluate(indicators)
      .then(outcome => {
        this.#cache.set(group, { at: Date.now(), outcome })
        return outcome
      })
      .finally(() => {
        this.#inflight.delete(group)
      })

    this.#inflight.set(group, evaluation)

    return evaluation
  }

  async #evaluate(indicators: readonly HealthIndicator[]): Promise<GroupOutcome> {
    if (indicators.length === 0) {
      return EMPTY_OUTCOME
    }

    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('deadline')), this.#options.probeDeadlineMs)
    timer.unref?.()

    try {
      const outcomes = await Promise.all(indicators.map(indicator => this.#check(indicator, deadline.signal)))

      let ok = true
      let degraded = false

      for (const outcome of outcomes) {
        if (outcome.status === 'up') {
          continue
        }
        if (outcome.status === 'down' && outcome.critical) {
          ok = false
        } else {
          degraded = true
        }
      }

      return { ok, degraded, outcomes }
    } finally {
      clearTimeout(timer)
    }
  }

  async #check(indicator: HealthIndicator, deadline: AbortSignal): Promise<IndicatorOutcome> {
    const critical = indicator.critical
    const started = Date.now()
    const controller = new AbortController()
    const abort = (reason: unknown): void => controller.abort(reason)

    if (deadline.aborted) {
      abort(deadline.reason)
    } else {
      deadline.addEventListener('abort', () => abort(deadline.reason), { once: true })
    }

    const timer = setTimeout(() => abort(new Error('timeout')), this.#options.indicatorTimeoutMs)
    timer.unref?.()

    // An indicator is not obliged to honour the signal, so the deadline is enforced by racing it rather than by
    // trusting it. `settled` is what keeps the loser of the race from rejecting later, unobserved.
    let settled = false
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        if (!settled) {
          reject(controller.signal.reason)
        }
      }
      if (controller.signal.aborted) {
        onAbort()
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    try {
      const report: HealthReport = await Promise.race([
        Promise.resolve(indicator.check(controller.signal)),
        aborted,
      ])

      return {
        name: indicator.name,
        status: report.status,
        critical,
        detail: report.detail,
        data: report.data,
        durationMs: Date.now() - started,
      }
    } catch (error) {
      return {
        name: indicator.name,
        status: 'down',
        critical,
        detail: reasonOf(error),
        durationMs: Date.now() - started,
      }
    } finally {
      settled = true
      clearTimeout(timer)
      if (onAbort !== undefined) {
        controller.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
