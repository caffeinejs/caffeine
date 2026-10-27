import { $t, type InferSchema } from '@caffeinejs/application/schema'

/** One configuration value, and where it came from. */
export const PropertySchema = $t.Object({
  /** The dotted path, `db.url`. */
  path: $t.String(),
  /** What set it: `env:DB_URL`, a file, a layer's name; `default` for a schema default. */
  origin: $t.String(),
  /** Masked when shown: a `$t.Secret` field, a path naming a secret, or one `redact(...)` names. */
  secret: $t.Boolean(),
  /** Present only when the devtools were told to show values, with every secret masked. */
  value: $t.Optional($t.Unknown()),
})

/** One value and every layer that set it, winner first. */
export const PropertyDetailSchema = $t.Object({
  ...PropertySchema.properties,
  layers: $t.Array($t.Object({ layer: $t.String(), origin: $t.String(), value: $t.Optional($t.Unknown()) })),
})

/** A configuration source, as the store last loaded it. */
export const SourceSchema = $t.Object({
  name: $t.String(),
  trigger: $t.String(),
  layers: $t.Array($t.String()),
  keys: $t.Integer(),
  /** In milliseconds since the epoch; `0` before a load has succeeded. */
  lastLoadedAt: $t.Number(),
  /** A duration, in milliseconds. */
  lastLoadDuration: $t.Number(),
  consecutiveFailures: $t.Integer(),
  /** The message of the last failure, the password of any URL in it masked. */
  lastError: $t.Optional($t.String()),
})

export type PropertyRecord = InferSchema<typeof PropertySchema>
export type PropertyDetail = InferSchema<typeof PropertyDetailSchema>
export type SourceRecord = InferSchema<typeof SourceSchema>
