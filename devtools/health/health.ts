import { DevTool, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import { ApplicationAvailability, ApplicationHealth, type ProbeResult } from '@caffeinejs/application/health'
import type { Container } from '@caffeinejs/di'

const GROUPS = ['liveness', 'readiness', 'startup'] as const

type Group = (typeof GROUPS)[number]

/** Where the application stands: whether it is alive, accepting traffic and started, and why not. */
export interface AvailabilityRecord {
  readonly live: string
  readonly ready: string
  readonly started: boolean
  readonly draining: boolean
  readonly livenessReason: string | undefined
  readonly readinessReason: string | undefined
}

export interface HealthRecord {
  readonly availability: AvailabilityRecord
  readonly groups: Readonly<Record<Group, ProbeResult>>
}

/**
 * The application's health with every indicator's outcome and details, which the probes keep to themselves, and its
 * availability.
 *
 * - `GET /health`: availability and every group
 * - `GET /health/:group`: one group, `liveness`, `readiness` or `startup`
 */
export class HealthTool extends DevTool {
  readonly id = 'health'
  readonly title = 'Health'
  readonly description = 'Every health indicator with its details, and whether the application is live and ready'
  readonly operations: readonly DevToolOperation[]

  readonly #container: Container

  constructor(container: Container) {
    super()
    this.#container = container
    this.operations = [
      { method: 'GET', path: '', handle: () => this.#all() },
      { method: 'GET', path: '/:group', handle: ({ params }) => this.#group(params.group) },
    ]
  }

  async #all(): Promise<HealthRecord> {
    const [liveness, readiness, startup] = await Promise.all(GROUPS.map(group => this.#probe(group)))

    return { availability: this.#availability(), groups: { liveness, readiness, startup } }
  }

  #group(group: string): Promise<ProbeResult> {
    if (!(GROUPS as readonly string[]).includes(group)) {
      throw new ErrDevToolNotFound(`No health group "${group}": the groups are ${GROUPS.join(', ')}`)
    }

    return this.#probe(group as Group)
  }

  #probe(group: Group): Promise<ProbeResult> {
    const health = this.#container.get(ApplicationHealth)

    return group === 'liveness' ? health.liveness() : group === 'readiness' ? health.readiness() : health.startup()
  }

  #availability(): AvailabilityRecord {
    const availability = this.#container.get(ApplicationAvailability)

    return {
      live: availability.live,
      ready: availability.ready,
      started: availability.started,
      draining: availability.draining,
      livenessReason: availability.livenessReason,
      readinessReason: availability.readinessReason,
    }
  }
}
