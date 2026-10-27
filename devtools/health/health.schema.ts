import { $t, type InferSchema } from '@caffeinejs/application/schema'

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
