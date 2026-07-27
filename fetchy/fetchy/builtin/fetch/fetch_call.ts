import type { Call } from '../../call.js'

/**
 * Default `fetch()`-based {@link Call}. Passes the native {@link Request} directly to `fetch()`.
 */
export class FetchCall implements Call {
  async execute(request: Request): Promise<Response> {
    return fetch(request)
  }
}
