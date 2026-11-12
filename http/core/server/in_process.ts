import { inProcessPlatform } from './fetch.js'
import type { HTTPServer } from './server.js'

/**
 * `IServer.request` for the engine: the request as `fetch(input, init)` describes it, answered with no socket. An
 * abort rejects the call while it is pending, and fails the body being read once it has been handed over.
 */
export function requestInProcess(
  server: HTTPServer,
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    // A path names a route of this server, where `Request` takes only an absolute URL.
    const request = new Request(
      typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
      init,
    )
    const { signal } = request
    signal.throwIfAborted()

    return new Promise<Response>((resolve, reject) => {
      let answer: Response | undefined

      signal.addEventListener(
        'abort',
        () => {
          if (answer === undefined) {
            reject(signal.reason)
          } else {
            inProcessPlatform.cancel(request, answer, signal.reason as Error)
          }
        },
        { once: true },
      )

      Promise.resolve(server.serve(inProcessPlatform, request, [], true)).then(response => {
        answer = response
        resolve(response)
      }, reject)
    })
  } catch (err) {
    return Promise.reject(err)
  }
}
