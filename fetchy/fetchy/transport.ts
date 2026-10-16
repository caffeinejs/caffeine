import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

/**
 * Sends a client's requests. A transport follows redirects as `fetch` does, up to 20 and to any origin, so that a call
 * returns the same whichever transport sends it.
 */
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
