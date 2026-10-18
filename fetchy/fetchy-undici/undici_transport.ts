import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

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

// A body that can be read once, a web stream or an iterator, as a Node stream. undici's redirect handling follows a 307
// or a 308 with a copy of the body, and cannot tell the first send read the original: the copy went out empty. A Node
// stream it watches being read, and hands the 3xx back instead.
function asNodeStream(body: object): Readable | undefined {
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as WebReadableStream)
  }

  if (typeof (body as { pipe?: unknown }).pipe === 'function' || ArrayBuffer.isView(body)) {
    return undefined
  }

  return Symbol.asyncIterator in body || Symbol.iterator in body
    ? Readable.from(body as AsyncIterable<unknown> | Iterable<unknown>)
    : undefined
}

/**
 * `Transport` implementation dispatching through an `undici` `Dispatcher`: a `Pool`, or an `Agent`.
 *
 * A `FormData` body, of any implementation, is streamed part by part as the connection takes it,
 * with its length, and encoded again on every send, so a retry or an authentication follow-up sends
 * every part again. A file part that cannot be read fails the call. So does one whose bytes do not
 * add up to its `size`, with undici's `RequestContentLengthMismatchError`, before a byte past the
 * length is sent: over HTTP/2 too, and whatever the dispatcher's `strictContentLength`.
 *
 * It follows redirects as far as its dispatcher does. `UndiciTransportFactory` composes undici's
 * redirect interceptor onto an `Agent`, which reaches any origin; a `Pool` follows none, and cannot
 * leave its origin. A stream or an iterator is read once, so a 307 or a 308 answered to one comes
 * back as the 3xx it is, and fails the call with `ErrFetchyHTTP`.
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
      } else {
        body = asNodeStream(requestBody) ?? body
      }
    }

    // An Agent sends a request to the origin it names; a Pool to its own, whatever it names.
    const data = await this.dispatcher.request({
      origin: request.origin,
      path: request.path,
      method: request.method as Dispatcher.HttpMethod,
      headers,
      body,
      signal: request.signal,
    })

    return new UndiciResponse(data)
  }
}
