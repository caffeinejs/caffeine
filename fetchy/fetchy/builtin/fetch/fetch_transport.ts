import type { FetchyRequest } from '../../request.js'
import type { FetchyResponse } from '../../response.js'
import type { Transport } from '../../transport.js'

/**
 * Default `fetch()`-based {@link Transport}. Resolves with the native {@link Response}.
 */
export class FetchTransport implements Transport {
  send(request: FetchyRequest): Promise<FetchyResponse> {
    return fetch(request.url, {
      method: request.method,
      headers: request.headers.record,
      body: request.body,
      signal: request.signal,
    })
  }
}
