import type { BindingGraph } from '@caffeinejs/di/graph'
import { API, GET } from '@caffeinejs/fetchy'

@API('/graph')
export class GraphAPI {
  @GET()
  get!: () => Promise<BindingGraph>
}
