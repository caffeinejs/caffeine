import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

export interface Transport {
  send(request: FetchyRequest): Promise<FetchyResponse>

  /**
   * Releases what the transport owns, such as pooled connections. `FetchyClient.close()` calls it once.
   */
  close?(): Promise<void>
}

export interface TransportFactory {
  provide(baseURL: string): Transport
}
