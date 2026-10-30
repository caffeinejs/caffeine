import { Router } from '@caffeinejs/http'

import { toolRoutes, type ToolRouter } from '../tool.js'
import { RuntimeSchema } from './runtime.schema.js'
import type { RuntimeTool } from './runtime.tool.js'

const runtime: ToolRouter<RuntimeTool, '/runtime'> = new Router('/runtime')

const read = runtime
  .get('')
  .schema({ response: { 200: RuntimeSchema } })
  .handler((_, { tool }) => tool.read())

/**
 * The process at the moment it is read.
 *
 * - `GET /runtime`
 */
export function runtimeRouter(tool: RuntimeTool) {
  return toolRoutes(tool, read)
}
