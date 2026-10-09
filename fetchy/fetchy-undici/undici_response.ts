import { Readable } from 'node:stream'

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
      const { done, value } = await iterator.next()

      if (done) {
        queueMicrotask(() => {
          controller.close()
          controller.byobRequest?.respond(0)
        })
        return
      }

      // A copy: a byte stream takes over the buffer it is given, and a Node chunk shares its pool's. A Node stream
      // never yields an empty chunk, which a byte stream would refuse.
      controller.enqueue(new Uint8Array(value))
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
  // Set once json(), text() or arrayBuffer() takes the body: the readable still looks unread after an empty one.
  #used = false

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

    if (this.#body === undefined) {
      this.#body = webStream(this.#data.body)

      // A body a read method took is locked to that read, as fetch's is.
      if (this.#used) {
        this.#body.getReader()
      }
    }

    return this.#body
  }

  get bodyUsed(): boolean {
    // `body` is disturbed as soon as a read is requested or it is cancelled, before the readable shows either.
    return this.#used || (this.#body !== undefined && Readable.isDisturbed(this.#body))
  }

  json(): Promise<unknown> {
    return this.#take() ? this.#data.body.json() : Promise.reject(new TypeError(BODY_USED))
  }

  text(): Promise<string> {
    return this.#take() ? this.#data.body.text() : Promise.reject(new TypeError(BODY_USED))
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#take() ? this.#data.body.arrayBuffer() : Promise.reject(new TypeError(BODY_USED))
  }

  // Takes the body for a read method and locks `body` to it, unless it was read or cancelled already or a reader holds
  // it: fetch refuses a read then.
  #take(): boolean {
    if (this.bodyUsed || this.#body?.locked === true) {
      return false
    }

    this.#used = true
    this.#body?.getReader()
    return true
  }
}
