import type { DevToolsHealthReport } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

@API('/health')
export class HealthAPI {
  @GET()
  get!: () => Promise<DevToolsHealthReport>
}
