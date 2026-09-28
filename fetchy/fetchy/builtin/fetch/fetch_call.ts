import type { Call } from '../../call.js'
import type { FetchyRequest } from '../../request.js'
import type { FetchyResponse } from '../../response.js'

/**
 * Default `fetch()`-based {@link Call}. Resolves with the native {@link Response}.
 */
export class FetchCall implements Call {
  execute(request: FetchyRequest): Promise<FetchyResponse> {
    return fetch(request.url, {
      method: request.method,
      headers: request.headers.record,
      body: request.body,
      signal: request.signal,
    })
  }
}
