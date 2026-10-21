import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

// The statuses a `Response` is built without a body for: its constructor refuses one.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * Sends `input` to `fastify` without a socket: the request as `fetch(input, init)` describes it, the answer as the
 * server wrote it, handed over at its headers with its body streaming. `IServer.fetch` is the contract.
 */
export async function fetchInProcess(
  fastify: FastifyInstance,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // A path names a route of this server, where `Request` takes only an absolute URL.
  const request = new Request(
    typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
    init,
  )
  const { signal } = request
  signal.throwIfAborted()

  // A client writes the host the URL names, leaving out the scheme's default port, which light-my-request writes.
  const headers: Record<string, string> = Object.fromEntries(request.headers)
  headers.host ??= new URL(request.url).host

  // The caller's body, read by the call alone, so that hanging up releases it as `fetch` cancels it.
  const source = request.body === null ? undefined : sourceOf(request.body)
  // What light-my-request reads the body from. A body under its own length, as a request a server received carries,
  // streams under it. One without, as a client builds it for its transport to measure, is read whole first.
  let upload = request.headers.has('content-length') || request.headers.has('transfer-encoding') ? source : undefined

  // The injection's own signal: aborting it closes the request the server holds, as a client closing its socket does.
  const injection = new AbortController()
  let answer: Readable | undefined
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  // The answer is closed first, so that light-my-request finds it closed rather than failing it with an error of its
  // own. The upload is failed rather than closed: that reaches a request whose body the server has read, which neither
  // a closed upload nor the injection's signal does any more.
  const hangUp = (reason: unknown): void => {
    answer?.destroy()
    upload?.destroy(new Error('The client hung up'))
    source?.destroy()
    injection.abort(reason)
  }
  const onAbort = (): void => {
    body?.error(signal.reason)
    hangUp(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  let result: LightMyRequestResponse
  try {
    if (source !== undefined && upload === undefined) {
      const whole = await untilAborted(buffer(source), signal)
      if (whole.byteLength > 0) {
        headers['content-length'] = String(whole.byteLength)
        upload = uploadOf(whole)
      }
    }

    result = await untilAborted(
      fastify.inject({
        method: request.method as InjectOptions['method'],
        url: request.url,
        headers,
        payload: upload,
        signal: injection.signal,
        payloadAsStream: true,
      }),
      signal,
      late => late.stream().destroy(),
    )
  } catch (err) {
    signal.removeEventListener('abort', onAbort)
    upload?.destroy()
    source?.destroy()
    throw err
  }

  answer = result.stream()
  answer.once('close', () => signal.removeEventListener('abort', onAbort))

  // The upload is let go once the server has answered, read or not, as a socket stops carrying it.
  const release = (): void => {
    upload?.destroy()
    source?.destroy()
  }
  const served = result.raw.res
  if (served.destroyed) {
    release()
  } else {
    served.once('close', release)
  }

  // light-my-request writes every header as a string or a list of them.
  const responseHeaders = new Headers()
  for (const [key, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        responseHeaders.append(key, String(v))
      }
    } else {
      responseHeaders.set(key, String(value))
    }
  }

  const nullBody = NULL_BODY_STATUSES.has(result.statusCode)

  try {
    // A 1xx status has no `Response` at all: the constructor's RangeError rejects the call.
    const response = new Response(nullBody ? null : bodyOf(answer, controller => void (body = controller), hangUp), {
      status: result.statusCode,
      statusText: result.statusMessage,
      headers: responseHeaders,
    })

    if (nullBody) {
      answer.resume()
    }

    return response
  } catch (err) {
    hangUp(err)
    throw err
  }
}

// The caller's body as a Node stream. Closing it cancels the caller's, which `Readable.fromWeb` does too, but this one
// never ends on its own account: light-my-request ignores a request it is told to close once it has read it all, and
// failing the stream it reads from is what still reaches it then.
function sourceOf(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader()

  return new Readable({
    autoDestroy: false,
    read() {
      reader.read().then(
        chunk => this.push(chunk.done ? null : chunk.value),
        (error: unknown) => this.destroy(error as Error),
      )
    },
    destroy(error, callback) {
      reader.cancel(error ?? undefined).then(
        () => callback(error),
        () => callback(error),
      )
    },
  })
}

// A body read whole, sent the way `sourceOf` sends one.
function uploadOf(whole: Buffer): Readable {
  return Readable.from([whole], { objectMode: false, autoDestroy: false })
}

// The answer's body as `fetch` hands one over. It is pulled from the answer as it is read, so that nothing is pushed
// into a body its reader has let go of, and a cancel is the client hanging up. Each chunk is a copy: light-my-request's
// share a pooled buffer, and a reader may keep what it is handed.
function bodyOf(
  answer: Readable,
  opened: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  hangUp: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const chunks = answer[Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    start: opened,
    async pull(controller) {
      const chunk = await chunks.next()
      if (chunk.done) {
        controller.close()
      } else {
        controller.enqueue(new Uint8Array(chunk.value as Uint8Array))
      }
    },
    cancel: hangUp,
  })
}

// Settles as `pending` does, or rejects with the signal's reason the moment it aborts. What `pending` resolves with
// after that goes to `late`, and what it rejects with is nobody's.
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason)
      pending.then(late, () => undefined)
    }

    if (signal.aborted) {
      abort()
      return
    }

    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
