import type { DevToolsConfigurationReport } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

@API('/configuration')
export class ConfigurationAPI {
  @GET()
  get!: () => Promise<DevToolsConfigurationReport>
}
