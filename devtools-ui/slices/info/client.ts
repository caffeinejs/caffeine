import type { DevToolsInfoReport } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

@API('/info')
export class InfoAPI {
  @GET()
  get!: () => Promise<DevToolsInfoReport>
}
