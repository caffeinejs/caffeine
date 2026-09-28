import type { FetchyResponse } from '@caffeinejs/fetchy'
import type { Dispatcher } from 'undici'

import { fromUndiciHeaders } from './headers_util.js'

const NULL_BODY_STATUSES = new Set([204, 205, 304])

// What fetch rejects a second read with. undici instead fails an internal assertion, synchronously.
const BODY_USED = 'Body is unusable: Body has already been read'

/**
 * The {@link FetchyResponse} an undici `request` resolves to. It is not an `instanceof Response`.
 */
export class UndiciResponse implements FetchyResponse {
  readonly #data: Dispatcher.ResponseData
  #headers: Headers | undefined

  constructor(data: Dispatcher.ResponseData) {
    this.#data = data
  }

  get status(): number {
    return this.#data.statusCode
  }

  get statusText(): string {
    return this.#data.statusText
  }

  get ok(): boolean {
    return this.#data.statusCode >= 200 && this.#data.statusCode <= 299
  }

  get headers(): Headers {
    return (this.#headers ??= fromUndiciHeaders(this.#data.headers))
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (NULL_BODY_STATUSES.has(this.#data.statusCode)) {
      return null
    }

    // undici types its body mixin's `body` as `never`, but the readable builds the web stream on first access.
    return (this.#data.body as unknown as { body: ReadableStream<Uint8Array> }).body
  }

  get bodyUsed(): boolean {
    return this.#data.body.bodyUsed
  }

  json(): Promise<unknown> {
    return this.#data.body.bodyUsed ? Promise.reject(new TypeError(BODY_USED)) : this.#data.body.json()
  }

  text(): Promise<string> {
    return this.#data.body.bodyUsed ? Promise.reject(new TypeError(BODY_USED)) : this.#data.body.text()
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#data.body.bodyUsed ? Promise.reject(new TypeError(BODY_USED)) : this.#data.body.arrayBuffer()
  }
}
