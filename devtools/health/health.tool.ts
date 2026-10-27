import { ApplicationAvailability, ApplicationHealth, type ProbeResult } from '@caffeinejs/application/health'
import type { Container } from '@caffeinejs/di'
import { ErrHTTPNotFound } from '@caffeinejs/http'

import type { ToolInfo } from '../tool.js'
import type { AvailabilityRecord, HealthRecord, ProbeRecord } from './health.schema.js'

const GROUPS = ['liveness', 'readiness', 'startup'] as const

type Group = (typeof GROUPS)[number]

export const healthTool: ToolInfo = {
  id: 'health',
  title: 'Health',
  description: 'Every health indicator with its details, and whether the application is live and ready',
}

/** Runs the application's probes, keeping every indicator's outcome and details. */
export class HealthTool {
  readonly #container: Container

  constructor(container: Container) {
    this.#container = container
  }

  async health(): Promise<HealthRecord> {
    const [liveness, readiness, startup] = await Promise.all(GROUPS.map(group => this.#probe(group)))

    return { availability: availabilityOf(this.#container), groups: { liveness, readiness, startup } }
  }

  /** @throws ErrHTTPNotFound when `group` is not `liveness`, `readiness` or `startup`. */
  group(group: string): Promise<ProbeRecord> {
    if (!isGroup(group)) {
      throw new ErrHTTPNotFound(`No health group "${group}": the groups are ${GROUPS.join(', ')}`)
    }

    return this.#probe(group)
  }

  async #probe(group: Group): Promise<ProbeRecord> {
    const health = this.#container.get(ApplicationHealth)
    const probes = {
      liveness: () => health.liveness(),
      readiness: () => health.readiness(),
      startup: () => health.startup(),
    }

    return recordOf(await probes[group]())
  }
}

function isGroup(group: string): group is Group {
  return (GROUPS as readonly string[]).includes(group)
}

function recordOf(result: ProbeResult): ProbeRecord {
  return { ok: result.ok, checks: [...result.checks], outcomes: [...result.outcomes] }
}

function availabilityOf(container: Container): AvailabilityRecord {
  const availability = container.get(ApplicationAvailability)

  return {
    live: availability.live,
    ready: availability.ready,
    started: availability.started,
    draining: availability.draining,
    livenessReason: availability.livenessReason,
    readinessReason: availability.readinessReason,
  }
}
