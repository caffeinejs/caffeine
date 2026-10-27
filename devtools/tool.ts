import { $t } from '@caffeinejs/application/schema'
import { $i } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'

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

/**
 * A router whose routes read their tool from `deps.tool`. Its routes are declared once, at module scope, and
 * {@link toolRoutes} injects the tool each devtools mount builds where it groups them.
 */
export type ToolRouter<T, P extends string> = Router<Record<never, never>, Record<never, never>, { tool: T }, P>

/** Groups a tool's routes, handing each of them `tool` as `deps.tool`. */
export function toolRoutes<T, const RS extends ReadonlyArray<Router<any, any, { tool: T }, any, any, never>>>(
  tool: T,
  ...routes: RS
) {
  return new Router().inject({ tool: $i.just(tool) }).mount(...routes)
}
