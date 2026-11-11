import type { Container } from '@caffeinejs/di'
import { ProblemSchema, Router } from '@caffeinejs/http'

import { toolRoutes, type ToolRouter } from '../tool.js'
import { HealthSchema, ProbeSchema } from './health.schema.js'
import { HealthTool } from './health.tool.js'

const health: ToolRouter<HealthTool, '/health'> = new Router('/health')

const all = health
  .get('')
  .schema({ response: { 200: HealthSchema } })
  .handler((_, { tool }) => tool.health())

const one = health
  .get('/:group')
  .schema({ response: { 200: ProbeSchema, 404: ProblemSchema } })
  .handler((ctx, { tool }) => tool.group(ctx.req.param().group))

/**
 * The application's health with every indicator's outcome and details, which the probes keep to themselves, and its
 * availability.
 *
 * - `GET /health`: availability and every group
 * - `GET /health/:group`: one group, `liveness`, `readiness` or `startup`
 */
export function healthRouter(container: Container) {
  return toolRoutes(new HealthTool(container), all, one)
}
