import { ErrFetchyInvalidMultipartBody } from '../errors.js'
import { isFormData, isFormDataLike } from '../internal/form_data.js'
import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'
import type { Transport } from '../transport.js'

// Node's fetch is undici's. Given a FormData, it sends the parts again after a 307 or a 308 under a boundary its
// content-type does not name, and on Node 24 reads every part ahead of the server and leaves a part it cannot read as an
// unhandled rejection. Where it runs, the transport encodes the FormData itself; elsewhere fetch encodes it.
const UNDICI_FETCH = typeof process === 'object' && typeof process.versions?.undici === 'string'

// The escapes and line breaks of the HTML multipart/form-data encoding, as undici's fetch writes them.
function escapeQuoted(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22')
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r?\n|\r/g, '\r\n')
}

// A Blob as the platform built it. One that overrides `size` or `stream()`, as a file made up as it is read does, holds
// other bytes than the ones a Blob composed of it would send.
function isPlainBlob(value: Blob): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)

  return (
    (prototype === Blob.prototype || prototype === File.prototype) &&
    !Object.hasOwn(value, 'size') &&
    !Object.hasOwn(value, 'stream')
  )
}

function newBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))

  return `----fetchy-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

// Encodes a FormData of any implementation as undici's fetch does, apart from the boundary, into a Blob composed of the
// parts: fetch reads it as the connection takes it, and sends the same bytes again after a 307 or a 308. A part that is
// a Blob of another implementation would go in as text, and is refused. A body holding a part that makes its own bytes
// is left to fetch, which reads them through `stream()`: `undefined`.
function encodeFormData(form: FormData): { contentType: string; body: Blob } | undefined {
  const boundary = newBoundary()
  const parts: (string | Blob)[] = []

  for (const [name, value] of form as Iterable<[unknown, unknown]>) {
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(normalizeLineBreaks(String(name)))}"`

    if (typeof value === 'string') {
      parts.push(`${disposition}\r\n\r\n${normalizeLineBreaks(value)}\r\n`)
      continue
    }

    if (!(value instanceof Blob)) {
      throw new ErrFetchyInvalidMultipartBody(value, String(name))
    }

    if (!isPlainBlob(value)) {
      return undefined
    }

    // FormData names a Blob that is not a File "blob". As undici's fetch does, a File named '' gets no filename, which
    // makes it a text part.
    const filename = value instanceof File ? value.name : 'blob'

    parts.push(
      `${disposition}${filename ? `; filename="${escapeQuoted(filename)}"` : ''}\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
      value,
      '\r\n',
    )
  }

  parts.push(`--${boundary}--\r\n`)

  return { contentType: `multipart/form-data; boundary=${boundary}`, body: new Blob(parts) }
}

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
 * On Node, a `FormData` body of any implementation is encoded by the transport rather than by
 * `fetch`: each part is read as the connection takes it, a file part that cannot be read fails the
 * call, and a 307 or a 308 sends every part again. A body holding a part that makes its own bytes,
 * by overriding `size` or `stream()`, is left to `fetch`, as every `FormData` is elsewhere. A part
 * that is a `Blob` or `File` of another implementation fails the call with
 * `ErrFetchyInvalidMultipartBody`.
 *
 * A `ReadableStream` body is sent as it is read. Browsers send one only over HTTP/2 or later, and
 * Firefox and Safari not at all.
 */
export class FetchTransport implements Transport {
  send(request: FetchyRequest): Promise<FetchyResponse> {
    let body = request.body
    let headers = request.headers.record

    if (typeof body === 'object' && body !== null && (isFormData(body) || isFormDataLike(body))) {
      try {
        const encoded = UNDICI_FETCH ? encodeFormData(body) : undefined
        // No content-type or content-length set before the parts are encoded can be theirs, and an interceptor may have
        // set either: under a boundary the body does not use, or past its end, the call would fail or never end. The
        // request keeps them: a retry or an authentication follow-up sends that request again.
        const { 'content-type': _contentType, 'content-length': _contentLength, ...rest } = headers

        if (encoded === undefined) {
          body = isFormData(body) ? body : toGlobalFormData(body)
          headers = rest
        } else {
          body = encoded.body
          headers = { ...rest, 'content-type': encoded.contentType }
        }
      } catch (err) {
        return Promise.reject(err)
      }
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
