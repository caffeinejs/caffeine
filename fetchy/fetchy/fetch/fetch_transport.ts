import { ErrFetchyInvalidMultipartBody } from '../errors.js'
import { isFormData, isFormDataLike } from '../internal/form_data.js'
import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'
import type { Transport } from '../transport.js'

// fetch encodes a FormData of its own class only, and sends one of any other, undici's included, as the text
// "[object FormData]". Its parts go into one fetch encodes; a Blob of another implementation would go in as text too.
function toGlobalFormData(form: FormData): FormData {
  const copy = new FormData()

  for (const [name, value] of form as Iterable<[string, unknown]>) {
    if (typeof value !== 'string' && !(value instanceof Blob)) {
      throw new ErrFetchyInvalidMultipartBody(value, name)
    }

    copy.append(name, value)
  }

  return copy
}

/**
 * Default `fetch()`-based {@link Transport}. Resolves with the native {@link Response}.
 *
 * On Node, `fetch` reads every part of a `FormData` body into memory, file-backed `Blob`s included,
 * ahead of the server. A file it cannot read, deleted or changed since `fs.openAsBlob()`, raises an
 * unhandled rejection and leaves the call pending, on a retry as well. The transport of
 * `@caffeinejs/fetchy-undici` streams each part and fails the call instead.
 *
 * A `FormData` of another implementation, such as undici's, is copied part by part into the global
 * one, which `fetch` alone encodes. A part that is a `Blob` or `File` of another implementation fails
 * the call with `ErrFetchyInvalidMultipartBody`.
 *
 * Redirects are followed, as `fetch` follows them. On Node, `fetch` sends a `FormData` body answered
 * 307 or 308 again under a new boundary, while its `content-type` keeps the first: a server cannot
 * parse it. The transport of `@caffeinejs/fetchy-undici` sends every part again under one boundary.
 *
 * A `ReadableStream` body is sent as it is read. Browsers send one only over HTTP/2 or later, and
 * Firefox and Safari not at all.
 */
export class FetchTransport implements Transport {
  send(request: FetchyRequest): Promise<FetchyResponse> {
    let body = request.body
    let headers = request.headers.record

    if (typeof body === 'object' && body !== null && !isFormData(body) && isFormDataLike(body)) {
      try {
        body = toGlobalFormData(body)
      } catch (err) {
        return Promise.reject(err)
      }
    }

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
