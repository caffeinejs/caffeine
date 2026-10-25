import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'

import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

import { connectionFields } from './response.js'

// The statuses a `Response` is built without a body for: its constructor refuses one.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

// The methods Node's `fetch` sends under `Content-Length: 0` when they carry no body: undici's `expectsPayload`.
const EXPECTS_PAYLOAD = new Set(['POST', 'PUT', 'PATCH', 'QUERY', 'PROPFIND', 'PROPPATCH'])

const FIX_LENGTH = 'Set Content-Length to the length of the body in bytes, or leave it out for the call to measure it'

/**
 * Sends `input` to `fastify` without a socket: the request as `fetch(input, init)` describes it, the answer as the
 * server wrote it, handed over at its headers with its body streaming. `IServer.request` is the contract.
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

  const chunked = request.headers.has('transfer-encoding')
  const length = lengthOf(request, chunked)

  // `fetch` measures a request with no body itself, whatever length it declares: `0` for a method that expects a
  // body, none for any other.
  if (request.body === null) {
    delete headers['content-length']
    if (!chunked && EXPECTS_PAYLOAD.has(request.method)) {
      headers['content-length'] = '0'
    }
  }

  // The call's own end: the caller's abort, or a body that cannot be sent as its headers describe it.
  const call = new AbortController()
  const fail = (error: TypeError): void => call.abort(error)

  // The caller's body, read by the call alone, so that hanging up releases it as `fetch` cancels it.
  const source = request.body === null ? undefined : sourceOf(request.body, length, fail)
  // What light-my-request reads the body from. A chunked body, or one under a length of its own, as a request a server
  // received carries, streams. One without, as a client builds it for its transport to measure, is read whole first,
  // and so is one declared empty: a server never reads that one, so it is found empty or not before it is sent.
  let upload = chunked || (length !== undefined && length > 0) ? source : undefined

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
  const ended = new Promise<never>((_, reject) => {
    call.signal.addEventListener(
      'abort',
      () => {
        body?.error(call.signal.reason)
        hangUp(call.signal.reason)
        reject(call.signal.reason)
      },
      { once: true },
    )
  })
  const onAbort = (): void => call.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })

  const send = async (): Promise<LightMyRequestResponse> => {
    if (source !== undefined && upload === undefined) {
      const whole = await buffer(source)
      headers['content-length'] = String(whole.byteLength)
      upload = uploadOf(whole)
      // An abort that came as the body ended: an injection started under it would fail an answer nothing hears.
      call.signal.throwIfAborted()
    }

    return fastify.inject({
      method: request.method as InjectOptions['method'],
      url: request.url,
      headers,
      payload: upload,
      signal: injection.signal,
      payloadAsStream: true,
    })
  }

  let result: LightMyRequestResponse
  try {
    // An injection left behind settles unwatched: none starts after the call's end, and that end has closed its answer.
    result = await Promise.race([send(), ended])
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

  // No connection carried the answer, so nothing in it describes one: a chunked label would sit on bytes that are
  // already the payload.
  const describesConnection = connectionFields(responseHeaders)
  for (const name of [...responseHeaders.keys()]) {
    if (describesConnection(name)) {
      responseHeaders.delete(name)
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

// The Content-Length the request declares, or `undefined` when it declares none or is chunked. One that is not a count
// of bytes is refused before anything is sent, as `fetch` refuses it, and so is one beside Transfer-Encoding, which no
// sender may write (RFC 9112 §6.1).
function lengthOf(request: Request, chunked: boolean): number | undefined {
  const declared = request.headers.get('content-length')
  if (declared === null) {
    return undefined
  }

  if (chunked) {
    throw new TypeError(
      errMessage('Cannot send the request: it carries both Transfer-Encoding and Content-Length')
        .solutions('Leave out Content-Length on a chunked body')
        .build(),
    )
  }

  if (!/^\d+$/.test(declared)) {
    throw new TypeError(
      errMessage(`Cannot send the request: its Content-Length "${declared}" is not a count of bytes`)
        .solutions(FIX_LENGTH)
        .build(),
    )
  }

  return Number(declared)
}

function longer(length: number): TypeError {
  return new TypeError(
    errMessage(`Cannot send the request body: it is longer than its Content-Length of ${length} bytes`)
      .solutions(FIX_LENGTH)
      .build(),
  )
}

function shorter(sent: number, length: number): TypeError {
  return new TypeError(
    errMessage(
      `Cannot send the request body: it ended at ${sent} bytes, short of its Content-Length of ${length} bytes`,
    )
      .solutions(FIX_LENGTH)
      .build(),
  )
}

// The caller's body as a Node stream, framed at `length` when there is one: a byte past it, or an end short of it, is
// failed rather than sent, so the server never reads more than the request declared. Closing it cancels the caller's,
// which `Readable.fromWeb` does too, but this one never ends on its own account: light-my-request ignores a request it
// is told to close once it has read it all, and failing the stream it reads from is what still reaches it then.
function sourceOf(
  body: ReadableStream<Uint8Array>,
  length: number | undefined,
  fail: (error: TypeError) => void,
): Readable {
  const reader = body.getReader()
  let sent = 0

  return new Readable({
    autoDestroy: false,
    read() {
      reader.read().then(
        chunk => {
          // A read that settles once the call has let the body go belongs to no one.
          if (this.destroyed) {
            return
          }

          if (chunk.done) {
            if (length !== undefined && sent < length) {
              fail(shorter(sent, length))
            } else {
              this.push(null)
            }
            return
          }

          sent += chunk.value.byteLength
          if (length !== undefined && sent > length) {
            fail(longer(length))
          } else {
            this.push(chunk.value)
          }
        },
        (error: unknown) => fail(new TypeError('Cannot send the request body: its stream failed', { cause: error })),
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
