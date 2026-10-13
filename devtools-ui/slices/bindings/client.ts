import type { DevToolsBindingsReport } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

@API('/bindings')
export class BindingsAPI {
  @GET()
  get!: () => Promise<DevToolsBindingsReport>
}
