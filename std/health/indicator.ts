/** The verdict a single {@link HealthIndicator} returns for one evaluation. */
export type HealthStatus = 'up' | 'down' | 'degraded'

/**
 * The probe an indicator contributes to. An indicator declaring no group belongs to `readiness` only —
 * dependencies must never reach liveness, or a dependency blip restarts the process.
 */
export type HealthGroup = 'liveness' | 'readiness' | 'startup'

/** The groups an indicator joins when it declares none. */
export const DEFAULT_HEALTH_GROUPS: readonly HealthGroup[] = ['readiness']

/** One indicator's outcome. `detail` and `data` surface only in a verbose probe response. */
export interface HealthReport {
  status: HealthStatus
  detail?: string
  data?: Record<string, unknown>
}

/**
 * A dependency check contributed to a probe. Extend it, bind it with `.extends(HealthIndicator)`, and the HTTP
 * application discovers it through `container.getManyOptional(HealthIndicator)` — the same polymorphic pattern
 * `FeatureConfigurer` uses.
 *
 * `check` receives an {@link AbortSignal} that fires when the probe deadline elapses, so a slow dependency call
 * can be cancelled instead of outliving the response it was meant to produce.
 *
 * ```ts
 * class DatabaseHealth extends HealthIndicator {
 *   readonly name = 'database'
 *
 *   async check(signal: AbortSignal): Promise<HealthReport> {
 *     await this.db.query('SELECT 1', { signal })
 *     return up()
 *   }
 * }
 * ```
 */
export abstract class HealthIndicator {
  /** Identifies the indicator in a verbose probe body. Must be unique across the application. */
  abstract readonly name: string

  /** The probes this indicator contributes to. Defaults to {@link DEFAULT_HEALTH_GROUPS}. */
  readonly groups?: readonly HealthGroup[]

  /**
   * Whether a `down` verdict fails the probe. Defaults to `true`.
   *
   * Set it to `false` for a dependency the process can serve without: the indicator then reports `degraded`,
   * the probe stays 200, and the pod keeps taking traffic. Consider it for any dependency shared across every
   * replica — a critical indicator on a shared database removes the whole fleet from the Service at once, and no
   * pod then receives the traffic that would show it recovered.
   */
  readonly critical?: boolean

  abstract check(signal: AbortSignal): Promise<HealthReport> | HealthReport
}

/** A healthy report. */
export function up(data?: Record<string, unknown>): HealthReport {
  return data === undefined ? { status: 'up' } : { status: 'up', data }
}

/** A failing report. Fails the probe when the indicator is critical. */
export function down(detail?: string, data?: Record<string, unknown>): HealthReport {
  return { status: 'down', detail, data }
}

/** A failing report that never fails the probe. */
export function degraded(detail?: string, data?: Record<string, unknown>): HealthReport {
  return { status: 'degraded', detail, data }
}
