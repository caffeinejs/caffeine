import type { FetchyRequest, FetchyResponse, Transport } from '@caffeinejs/fetchy'
import type { Dispatcher } from 'undici'

import { encodeFormData } from './form_data_body.js'
import { UndiciResponse } from './undici_response.js'

type FormDataMethod = 'append' | 'delete' | 'get' | 'getAll' | 'has' | 'set'

// undici's own test for a FormData. Whatever passes it, undici would hand to an encoder that reads every part into
// memory first and waits forever on a FormData of any class but its own. A stream that calls itself FormData, as the
// form-data package's do, fails it and is still sent as a stream.
function isFormDataLike(body: object): body is FormData {
  const form = body as Partial<Record<FormDataMethod, unknown>> & { [Symbol.toStringTag]?: unknown }

  return (
    form[Symbol.toStringTag] === 'FormData' &&
    typeof form.append === 'function' &&
    typeof form.delete === 'function' &&
    typeof form.get === 'function' &&
    typeof form.getAll === 'function' &&
    typeof form.has === 'function' &&
    typeof form.set === 'function'
  )
}

/**
 * `Transport` implementation dispatching through an `undici` `Dispatcher` (typically a `Pool`).
 *
 * A `FormData` body, of any implementation, is streamed part by part as the connection takes it,
 * with its length, and encoded again on every send, so a retry or an authentication follow-up sends
 * every part again. A file part that cannot be read fails the call. So does one whose bytes do not
 * add up to its `size`, with undici's `RequestContentLengthMismatchError`, before a byte past the
 * length is sent: over HTTP/2 too, and whatever the dispatcher's `strictContentLength`.
 *
 * It resolves with a {@link FetchyResponse} that is not an `instanceof Response`. Read or cancel its body, or the
 * connection stays busy.
 */
export class UndiciTransport implements Transport {
  constructor(private readonly dispatcher: Dispatcher) {}

  async send(request: FetchyRequest): Promise<FetchyResponse> {
    const requestBody = request.body
    let headers = request.headers.record
    let body = requestBody as Dispatcher.RequestOptions['body']

    // undici sends a string, a Blob, an ArrayBuffer and any (async) iterable as it is. A URLSearchParams it would write
    // entry by entry, so it goes as the string fetch would have sent. A FormData goes under the boundary its encoding
    // names, whatever content-type the request carries.
    if (typeof requestBody === 'object' && requestBody !== null) {
      if (requestBody instanceof URLSearchParams) {
        body = requestBody.toString()
      } else if (isFormDataLike(requestBody)) {
        const form = encodeFormData(requestBody, request.signal)

        headers = { ...headers, 'content-type': form.contentType, 'content-length': String(form.length) }
        body = form.body as Dispatcher.RequestOptions['body']
      }
    }

    const data = await this.dispatcher.request({
      path: request.path,
      method: request.method as Dispatcher.HttpMethod,
      headers,
      body,
      signal: request.signal,
    })

    return new UndiciResponse(data)
  }
}
