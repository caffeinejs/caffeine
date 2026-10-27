import { $t } from '@caffeinejs/application/schema'
import { ProblemSchema, Router } from '@caffeinejs/http'

import { toolRoutes, type ToolRouter } from '../tool.js'
import { RefreshableSchema, RefreshSchema } from './refreshables.schema.js'
import type { RefreshablesTool } from './refreshables.tool.js'

const refreshables: ToolRouter<RefreshablesTool, '/refreshables'> = new Router('/refreshables')

const list = refreshables
  .get('')
  .schema({ response: { 200: $t.Array(RefreshableSchema) } })
  .handler((_, { tool }) => tool.list().map(([record]) => record))

const one = refreshables
  .get('/:id')
  .schema({ response: { 200: RefreshableSchema, 404: ProblemSchema } })
  .handler((ctx, { tool }) => tool.find(ctx.req.param().id)[0])

const refreshAll = refreshables
  .post('/refreshes')
  .schema({
    body: $t.Object({ label: $t.Optional($t.String()) }, { additionalProperties: false }),
    response: { 200: RefreshSchema, 400: ProblemSchema },
  })
  .handler((ctx, { tool }) => tool.refreshAll(ctx.req.body().label))

const refreshOne = refreshables
  .post('/:id/refreshes')
  // A body, though empty: a request changing something carries JSON, which a cross-site form cannot send.
  .schema({
    body: $t.Object({}, { additionalProperties: false }),
    response: { 200: RefreshSchema, 404: ProblemSchema },
  })
  .handler((ctx, { tool }) => tool.refreshOne(ctx.req.param().id))

/**
 * The refresh-scoped injectables, and refreshing them: all of them, those carrying a label, or one. A
 * self-refreshable instance refreshes in place; any other is destroyed and re-created on its next resolution.
 *
 * - `GET /refreshables`: every refresh-scoped injectable
 * - `GET /refreshables/:id`: one
 * - `POST /refreshables/refreshes`: refreshes every one, or those whose label `{ "label": "..." }` names
 * - `POST /refreshables/:id/refreshes`: refreshes that one
 */
export function refreshablesRouter(tool: RefreshablesTool) {
  return toolRoutes(tool, list, one, refreshAll, refreshOne)
}
