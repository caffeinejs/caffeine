import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

/**
 * Sends a client's requests.
 *
 * `FetchTransport`, and the transport `UndiciTransportFactory` provides, follow redirects as `fetch` does, up to 20 and
 * to any origin, so a call returns the same whichever of them sends it. A `UndiciTransport` built over a dispatcher of
 * your own follows what that dispatcher does, and a transport of your own decides for itself.
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
