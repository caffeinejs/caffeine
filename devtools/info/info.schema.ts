import { $t, type InferSchema } from '@caffeinejs/application/schema'

/** What the application is and what it runs on. */
export const InfoSchema = $t.Object({
  application: $t.Object({
    /** `caffeine.name`; `''` when the configuration sets none. */
    name: $t.String(),
    profiles: $t.Array($t.String()),
    /** What each feature reported it runs, as `RunInfo.contrib` holds it. */
    contrib: $t.Array($t.Object({ source: $t.String() }, { additionalProperties: true })),
  }),
  runtime: $t.Object({
    /** The `@caffeinejs/application` version; absent when a bundle left the manifest behind. */
    caffeine: $t.Optional($t.String()),
    node: $t.String(),
    platform: $t.String(),
    arch: $t.String(),
    pid: $t.Integer(),
    hostname: $t.String(),
    nodeEnv: $t.Optional($t.String()),
    /** An ISO 8601 timestamp. */
    startedAt: $t.String(),
    /** A duration, in milliseconds. */
    uptime: $t.Number(),
  }),
})

export type InfoRecord = InferSchema<typeof InfoSchema>
