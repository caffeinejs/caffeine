import { isFormData } from '../internal/form_data.js'
import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'
import type { Transport } from '../transport.js'

/**
 * Default `fetch()`-based {@link Transport}. Resolves with the native {@link Response}.
 *
 * On Node, `fetch` reads every part of a `FormData` body into memory, file-backed `Blob`s included,
 * ahead of the server. A file it cannot read, deleted or changed since `fs.openAsBlob()`, raises an
 * unhandled rejection and leaves the call pending, on a retry as well. The transport of
 * `@caffeinejs/fetchy-undici` streams each part and fails the call instead.
 *
 * A `ReadableStream` body is sent as it is read. Browsers send one only over HTTP/2 or later, and
 * Firefox and Safari not at all.
 */
export class FetchTransport implements Transport {
  send(request: FetchyRequest): Promise<FetchyResponse> {
    const body = request.body
    let headers = request.headers.record

    // fetch writes a FormData's boundary only into a request with no content-type, and sends a content-length the
    // request carries, though no length set before the parts are encoded can be theirs: one too short leaves the call
    // pending. An interceptor may have set either. The request keeps them: a retry or an authentication follow-up sends
    // that request again.
    if (
      typeof body === 'object' &&
      body !== null &&
      isFormData(body) &&
      (request.headers.has('content-type') || request.headers.has('content-length'))
    ) {
      const { 'content-type': _contentType, 'content-length': _contentLength, ...rest } = headers
      headers = rest
    }

    return fetch(request.url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      // fetch refuses a stream body without it, and ignores it on any other.
      duplex: 'half',
    })
  }
}
