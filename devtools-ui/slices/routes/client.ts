import type { DevToolsRoutesReport } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

@API('/routes')
export class RoutesAPI {
  @GET()
  get!: () => Promise<DevToolsRoutesReport>
}
