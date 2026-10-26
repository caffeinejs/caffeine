import { $t } from '@caffeinejs/application/schema'

/** What the devtools index says of a tool: the segment it is served under, and what it is for. */
export interface ToolInfo {
  /** The segment under the devtools path: `/devtools/<id>`. */
  readonly id: string
  readonly title: string
  readonly description: string
}

/** The body of a refusal, as the framework's error handler writes it for an `ErrHTTP`. */
export const ErrorSchema = $t.Object({
  statusCode: $t.Integer(),
  error: $t.String(),
  code: $t.String(),
  message: $t.String(),
})
