import type { DevToolsIndex } from '@caffeinejs/devtools'
import { API, GET } from '@caffeinejs/fetchy'

/** An application's DevTools index: the slices it serves. Called on the configured URL itself. */
@API()
export class IndexAPI {
  @GET()
  get!: () => Promise<DevToolsIndex>
}
