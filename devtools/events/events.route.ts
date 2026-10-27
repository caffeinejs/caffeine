import { $t } from '@caffeinejs/application/schema'
import { Router } from '@caffeinejs/http'

import { ErrorSchema, toolRoutes, type ToolRouter } from '../tool.js'
import { ContainerEventSchema } from './events.schema.js'
import type { EventsTool } from './events.tool.js'

const events: ToolRouter<EventsTool, '/events'> = new Router('/events')

const list = events
  .get('')
  .schema({
    querystring: $t.Object({
      after: $t.Optional($t.Integer({ minimum: 0 })),
      limit: $t.Optional($t.Integer({ minimum: 0 })),
    }),
    response: { 200: $t.Array(ContainerEventSchema), 400: ErrorSchema },
  })
  .handler((ctx, { tool }) => tool.list(ctx.req.query().after, ctx.req.query().limit))

/**
 * What the container did since the tool attached to its hooks.
 *
 * - `GET /events`: the events, oldest first; `?after=<seq>` those after one, `?limit=<n>` the last `n`
 */
export function eventsRouter(tool: EventsTool) {
  return toolRoutes(tool, list)
}
