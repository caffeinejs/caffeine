import type { IContextPlatform } from '../../adapter.js'
import type { SendPayload } from '../lifecycle/lifecycle.js'
import { readLimited } from './body.js'
import type { ResponseHead, SendHooks, ServerPlatform } from './platform.js'

/** What `ctx.platform` is on the fetch application. */
export interface FetchContextPlatform extends IContextPlatform {
  readonly name: 'fetch'
  /** What the runtime handed `fetch` after the request: Bun's server, a worker's `env` and execution context. */
  readonly runtime: readonly unknown[]
}

/** A streamed body being sent: settles when it has left, and can be cut. */
interface Tracked {
  readonly ended: Promise<void>
  abort(reason: Error): void
}

/** The fetch runtime's platform: a `Request` in, a `Response` out. */
export const fetchPlatform: ServerPlatform<Request, FetchContextPlatform, Response> = {
  name: 'fetch',
  method: request => request.method,
  target: request => {
    const url = request.url
    const path = url.indexOf('/', url.indexOf('://') + 3)
    return path === -1 ? '/' : url.slice(path)
  },
  protocol: request => (request.url.startsWith('https:') ? 'https' : 'http'),
  header: (request, name) => request.headers.get(name) ?? undefined,
  headers: request => Object.fromEntries(request.headers),
  request: request => request,
  hasBody: request => request.body !== null && request.headers.get('content-length') !== '0',
  bodyConsumed,
  readBody: (request, limit) => readLimited(request.body, limit),
  signal: request => request.signal,
  remoteAddress: () => undefined,
  context: (_request, extra) => ({ name: 'fetch', runtime: (extra as readonly unknown[] | undefined) ?? [] }),
  respond: (_request, head, payload, hooks) => {
    const tracked = payload instanceof ReadableStream ? trackEnd(payload) : undefined
    const answer = new Response(tracked?.stream ?? (payload as Exclude<SendPayload, ReadableStream>), {
      status: head.status,
      headers: headersOf(head),
    })

    // Registered once the `Response` exists, so one that refuses its head leaves nothing to cut.
    if (tracked === undefined) {
      hooks.sent()
    } else {
      hooks.cancelWith(reason => tracked.abort(reason))
      void tracked.ended.then(hooks.sent)
    }

    return answer
  },
}

/** As {@link fetchPlatform}, for `request()`: no socket, so seen as `http` from `127.0.0.1`. */
export const inProcessPlatform: ServerPlatform<Request, FetchContextPlatform, Response> = {
  ...fetchPlatform,
  protocol: () => 'http',
  remoteAddress: () => '127.0.0.1',
  // `request()` is the one caller whose abort must fail a body already handed over: its signal cuts the stream.
  respond: (request, head, payload, hooks) =>
    fetchPlatform.respond(request, head, payload, linkedTo(request.signal, hooks)),
}

// Read, or held by a reader that may be reading.
function bodyConsumed(request: Request): boolean {
  return request.bodyUsed || request.body?.locked === true
}

/** `hooks`, with a streamed answer cut when `signal` aborts, until it has been sent. */
function linkedTo(signal: AbortSignal, hooks: SendHooks): SendHooks {
  let onAbort: (() => void) | undefined

  return {
    sent: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }
      hooks.sent()
    },
    cancelWith(cancel) {
      hooks.cancelWith(cancel)

      if (signal.aborted) {
        cancel(signal.reason as Error)
      } else {
        onAbort = () => cancel(signal.reason as Error)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    },
  }
}

function headersOf(head: ResponseHead): Headers {
  const headers = new Headers()

  for (const name in head.headers) {
    const value = head.headers[name]

    if (typeof value === 'string') {
      headers.set(name, value)
    } else {
      for (const item of value) {
        headers.append(name, item)
      }
    }
  }

  return headers
}

/**
 * `source` as a stream whose end is known: `ended` settles once it has been read to the end, failed, or been
 * cancelled by its reader. `abort` errors it, so a pending read on a locked stream fails too, which `cancel()` on the
 * stream could not do.
 */
function trackEnd(source: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array> } & Tracked {
  const reader = source.getReader()
  let end!: () => void
  const ended = new Promise<void>(resolve => {
    end = resolve
  })
  let controller!: ReadableStreamDefaultController<Uint8Array>

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read()

        if (done) {
          c.close()
          end()
        } else {
          c.enqueue(value)
        }
      } catch (err) {
        c.error(err)
        end()
      }
    },
    cancel(reason) {
      end()
      return reader.cancel(reason)
    },
  })

  return {
    stream,
    ended,
    abort(reason) {
      try {
        controller.error(reason)
      } catch {
        // Already closed or errored: nothing is being sent.
      }
      void reader.cancel(reason).catch(() => undefined)
      end()
    },
  }
}
