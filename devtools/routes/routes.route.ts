import { $t } from '@caffeinejs/application/schema'
import type { Container } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'

import { toolRoutes, type ToolRouter } from '../tool.js'
import { SecuritySchema, ServerRoutesSchema } from './routes.schema.js'
import { RoutesTool } from './routes.tool.js'

const routes: ToolRouter<RoutesTool, '/routes'> = new Router('/routes')

const list = routes
  .get('')
  .schema({
    querystring: $t.Object({ server: $t.Optional($t.String()) }),
    response: { 200: $t.Array(ServerRoutesSchema) },
  })
  .handler((ctx, { tool }) => tool.servers(ctx.req.query().server))

const security = routes
  .get('/security')
  .schema({ response: { 200: SecuritySchema } })
  .handler((_, { tool }) => tool.security())

/**
 * Every route of every server, the routes plugins registered included, and what each one requires: its schemes,
 * the gate that authenticates it, its roles and policies, its guards and its cross-origin protection.
 *
 * - `GET /routes`: every server's routes; `?server=<name>` one server's, `?server=` the application's own
 * - `GET /routes/security`: the schemes, the fallback policy and the gates
 */
export function routesRouter(container: Container) {
  return toolRoutes(new RoutesTool(container), list, security)
}
