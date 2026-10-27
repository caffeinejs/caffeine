import { ApplicationAvailability, ApplicationHealth, type ProbeResult } from '@caffeinejs/application/health'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import type { Container } from '@caffeinejs/di'
import { blend, ErrHTTPNotFound, Router } from '@caffeinejs/http'

import { ErrorSchema, type ToolInfo } from '../tool.js'

const GROUPS = ['liveness', 'readiness', 'startup'] as const

type Group = (typeof GROUPS)[number]

/** A probe's verdict, and the checks and indicator outcomes it was reached from. */
export const ProbeSchema = $t.Object({
  ok: $t.Boolean(),
  checks: $t.Array($t.Object({ name: $t.String(), ok: $t.Boolean(), detail: $t.Optional($t.String()) })),
  outcomes: $t.Array(
    $t.Object({
      name: $t.String(),
      status: $t.UnionEnum(['up', 'down', 'degraded']),
      critical: $t.Boolean(),
      detail: $t.Optional($t.String()),
      data: $t.Optional($t.Record($t.String(), $t.Unknown())),
      /** A duration, in milliseconds. */
      duration: $t.Number(),
    }),
  ),
})

/** Where the application stands: whether it is alive, accepting traffic and started, and why not. */
export const AvailabilitySchema = $t.Object({
  live: $t.UnionEnum(['correct', 'broken']),
  ready: $t.UnionEnum(['accepting', 'refusing']),
  started: $t.Boolean(),
  draining: $t.Boolean(),
  livenessReason: $t.Optional($t.String()),
  readinessReason: $t.Optional($t.String()),
})

export const HealthSchema = $t.Object({
  availability: AvailabilitySchema,
  groups: $t.Object({ liveness: ProbeSchema, readiness: ProbeSchema, startup: ProbeSchema }),
})

export type ProbeRecord = InferSchema<typeof ProbeSchema>
export type AvailabilityRecord = InferSchema<typeof AvailabilitySchema>
export type HealthRecord = InferSchema<typeof HealthSchema>

export const healthTool: ToolInfo = {
  id: 'health',
  title: 'Health',
  description: 'Every health indicator with its details, and whether the application is live and ready',
}

/**
 * The application's health with every indicator's outcome and details, which the probes keep to themselves, and its
 * availability.
 *
 * - `GET /health`: availability and every group
 * - `GET /health/:group`: one group, `liveness`, `readiness` or `startup`
 */
export function healthRouter(container: Container) {
  const probe = async (group: Group): Promise<ProbeRecord> => {
    const health = container.get(ApplicationHealth)
    const probes = {
      liveness: () => health.liveness(),
      readiness: () => health.readiness(),
      startup: () => health.startup(),
    }

    return recordOf(await probes[group]())
  }

  const health = new Router('/health')

  const all = health
    .get('')
    .schema({ response: { 200: HealthSchema } })
    .handler(async (): Promise<HealthRecord> => {
      const [liveness, readiness, startup] = await Promise.all(GROUPS.map(probe))

      return { availability: availabilityOf(container), groups: { liveness, readiness, startup } }
    })

  const one = health
    .get('/:group')
    .schema({ response: { 200: ProbeSchema, 404: ErrorSchema } })
    .handler(ctx => {
      const group = ctx.req.param().group

      if (!isGroup(group)) {
        throw new ErrHTTPNotFound(`No health group "${group}": the groups are ${GROUPS.join(', ')}`)
      }

      return probe(group)
    })

  return blend(all, one)
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
