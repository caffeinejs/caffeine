import type { ConfigStore } from '@caffeinejs/application/config'
import type { Container } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'

import { toolRoutes, type ToolRouter } from '../tool.js'
import { InfoSchema } from './info.schema.js'
import { InfoTool } from './info.tool.js'

const info: ToolRouter<InfoTool, '/info'> = new Router('/info')

const read = info
  .get('')
  .schema({ response: { 200: InfoSchema } })
  .handler((_, { tool }) => tool.read())

/**
 * The application's name, profiles and what its features run, and the process it runs in.
 *
 * - `GET /info`
 */
export function infoRouter(container: Container, store: ConfigStore<unknown>) {
  return toolRoutes(new InfoTool(container, store), read)
}
