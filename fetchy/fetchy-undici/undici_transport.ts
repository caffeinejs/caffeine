import type { FetchyRequest, FetchyResponse, Transport } from '@caffeinejs/fetchy'
import type { Dispatcher } from 'undici'

import { UndiciResponse } from './undici_response.js'

/**
 * `Transport` implementation dispatching through an `undici` `Dispatcher` (typically a `Pool`).
 *
 * It resolves with a {@link FetchyResponse} that is not an `instanceof Response`. Read or cancel its body, or the
 * connection stays busy.
 */
export class UndiciTransport implements Transport {
  constructor(private readonly dispatcher: Dispatcher) {}

  async send(request: FetchyRequest): Promise<FetchyResponse> {
    const requestBody = request.body

    const data = await this.dispatcher.request({
      path: request.path,
      method: request.method as Dispatcher.HttpMethod,
      headers: request.headers.record,
      // undici also sends a Blob, an ArrayBuffer and any (async) iterable, but a URLSearchParams it would write entry
      // by entry, so it goes as the string fetch would have sent.
      body: (requestBody instanceof URLSearchParams
        ? requestBody.toString()
        : requestBody) as Dispatcher.RequestOptions['body'],
      signal: request.signal,
    })

    return new UndiciResponse(data)
  }
}
