import { $t, type InferSchema } from '@caffeinejs/application/schema'

/** An injectable a refresh re-creates, or refreshes in place when it is self-refreshable. */
export const RefreshableSchema = $t.Object({
  id: $t.Integer(),
  key: $t.String(),
  /** The descriptions of its labels: what a refresh by label names. */
  labels: $t.Array($t.String()),
})

/** What a refresh reached, and when it ended. */
export const RefreshSchema = $t.Object({
  refreshed: $t.Array(RefreshableSchema),
  /** An ISO 8601 timestamp. */
  at: $t.String(),
})

export type RefreshableRecord = InferSchema<typeof RefreshableSchema>
export type RefreshRecord = InferSchema<typeof RefreshSchema>
