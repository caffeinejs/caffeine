import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

export interface Call {
  execute(request: FetchyRequest): Promise<FetchyResponse>

  /**
   * Releases what the call owns, such as pooled connections. `FetchyClient.close()` calls it once.
   */
  close?(): Promise<void>
}

export interface CallFactory {
  provide(baseURL: string): Call
}
