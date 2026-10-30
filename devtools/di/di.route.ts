import { $t } from '@caffeinejs/application/schema'
import type { Container } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'

import { ErrorSchema, toolRoutes, type ToolRouter } from '../tool.js'
import { BindingSchema, DependencyGraphSchema, InternalQuerySchema } from './di.schema.js'
import { DITool } from './di.tool.js'

const di: ToolRouter<DITool, '/di'> = new Router('/di')

const bindings = di
  .get('/bindings')
  .schema({ querystring: InternalQuerySchema, response: { 200: $t.Array(BindingSchema) } })
  .handler((ctx, { tool }) => tool.bindings(ctx.req.query().internal === 'true'))

const binding = di
  .get('/bindings/:id')
  .schema({ response: { 200: BindingSchema, 404: ErrorSchema } })
  .handler((ctx, { tool }) => tool.binding(ctx.req.param().id))

const bindingGraph = di
  .get('/graph')
  .schema({ querystring: InternalQuerySchema, response: { 200: DependencyGraphSchema } })
  .handler((ctx, { tool }) => tool.graph(ctx.req.query().internal === 'true'))

/**
 * The container's bindings, as a table and as a dependency graph.
 *
 * - `GET /di/bindings`: every binding; `?internal=true` adds the framework's own
 * - `GET /di/bindings/:id`: one binding
 * - `GET /di/graph`: the dependency graph with its Mermaid source; `?internal=true` as above
 */
export function diRouter(container: Container) {
  return toolRoutes(new DITool(container), bindings, binding, bindingGraph)
}
