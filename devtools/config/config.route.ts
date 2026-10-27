import { $t } from '@caffeinejs/application/schema'
import { Router } from '@caffeinejs/http'

import { ErrorSchema, toolRoutes, type ToolRouter } from '../tool.js'
import { PropertyDetailSchema, PropertySchema, SourceSchema } from './config.schema.js'
import type { ConfigTool } from './config.tool.js'

const config: ToolRouter<ConfigTool, '/config'> = new Router('/config')

const properties = config
  .get('/properties')
  .schema({ response: { 200: $t.Array(PropertySchema) } })
  .handler((_, { tool }) => tool.properties())

const property = config
  .get('/properties/:path')
  .schema({ response: { 200: PropertyDetailSchema, 404: ErrorSchema } })
  .handler((ctx, { tool }) => tool.property(ctx.req.param().path))

const sources = config
  .get('/sources')
  .schema({ response: { 200: $t.Array(SourceSchema) } })
  .handler((_, { tool }) => tool.sources())

/**
 * The application's configuration: every value's path and where it came from, and the sources it was loaded from.
 *
 * - `GET /config/properties`: every value
 * - `GET /config/properties/:path`: one value and every layer that set it
 * - `GET /config/sources`: the sources, with when each last loaded and its last failure
 */
export function configRouter(tool: ConfigTool) {
  return toolRoutes(tool, properties, property, sources)
}
