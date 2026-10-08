import type { FetchyResponse } from '@caffeinejs/fetchy'
import type { Dispatcher } from 'undici'

import { fromUndiciHeaders } from './headers_util.js'

const NULL_BODY_STATUSES = new Set([204, 205, 304])

// What fetch rejects a second read with. undici instead fails an internal assertion, synchronously.
const BODY_USED = 'Body is unusable: Body has already been read'

// The web stream undici builds for a body, but for `cancel()`. undici's returns the readable's iterator, which does
// nothing before the first read: a body nobody read stays open, and one still arriving keeps its connection. This one
// destroys the readable, as cancelling a fetch body aborts it.
function webStream(readable: Dispatcher.ResponseData['body']): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array>

  return new ReadableStream({
    type: 'bytes',
    start() {
      iterator = readable[Symbol.asyncIterator]()
    },
    async pull(controller) {
      for (;;) {
        const { done, value } = await iterator.next()

        if (done) {
          queueMicrotask(() => {
            controller.close()
            controller.byobRequest?.respond(0)
          })
          return
        }

        // A copy: a byte stream takes over the buffer it is given, and a Node chunk shares its pool's.
        if (value.byteLength > 0) {
          controller.enqueue(new Uint8Array(value))
          return
        }
      }
    },
    cancel() {
      // Destroyed before its end, the readable emits an error that nothing else listens for.
      readable.on('error', () => undefined).destroy()
    },
  })
}

/**
 * The {@link FetchyResponse} an undici `request` resolves to. It is not an `instanceof Response`.
 */
export class UndiciResponse implements FetchyResponse {
  readonly #data: Dispatcher.ResponseData
  #headers: Headers | undefined
  #body: ReadableStream<Uint8Array> | undefined

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

    // A body json(), text() or arrayBuffer() already read keeps undici's stream, which undici locks as fetch would.
    // undici types its body mixin's `body` as `never`, but the readable builds the web stream on first access.
    this.#body ??= this.#data.body.bodyUsed
      ? (this.#data.body as unknown as { body: ReadableStream<Uint8Array> }).body
      : webStream(this.#data.body)

    return this.#body
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
