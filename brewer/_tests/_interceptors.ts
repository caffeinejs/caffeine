import type { Interceptor } from '../index.js'

// Interceptors as applications write them, shared by the tests that run them against a real server.

/** Gives each request that enters it an ID of its own, as a trace header. */
export function tracing(next: () => string): Interceptor {
  return async (request, send) => {
    request.headers.set('x-request-id', next())
    return send(request)
  }
}

/** Stamps a key on every write that has none, once, so that every retry of it carries the same one. */
export function idempotency(next: () => string): Interceptor {
  return async (request, send) => {
    if (request.method === 'POST' && !request.headers.has('idempotency-key')) {
      request.headers.set('idempotency-key', next())
    }
    return send(request)
  }
}

/** Retries a 502, 503 or 504 and a failure to connect, a clone on every attempt but the last. */
export function retry(options: {
  attempts: number
  wait?: (attempt: number) => Promise<void>
  settled?: () => void
}): Interceptor {
  return async (request, next) => {
    try {
      for (let attempt = 1; ; attempt++) {
        const last = attempt === options.attempts
        try {
          const response = await next(last ? request : request.clone())
          if (last || ![502, 503, 504].includes(response.status)) {
            return response
          }
          await response.body?.cancel()
        } catch (error) {
          if (last || !(error instanceof TypeError)) {
            throw error
          }
        }
        await options.wait?.(attempt)
        request.signal.throwIfAborted()
      }
    } finally {
      options.settled?.()
    }
  }
}

/** Gives each attempt a deadline of its own, on a signal that still follows the call's. */
export function timeout(deadline: () => Promise<void>): Interceptor {
  return async (request, next) => {
    const expired = new AbortController()
    void deadline().then(() => expired.abort(new DOMException('The attempt took too long', 'TimeoutError')))
    return next(new Request(request, { signal: AbortSignal.any([request.signal, expired.signal]) }))
  }
}

/** Logs each exchange: the path without its query, headers with credentials redacted, a JSON body by its size. */
export function logging(lines: string[]): Interceptor {
  return async (request, next) => {
    const { pathname } = new URL(request.url)
    const headers = [...request.headers].map(
      ([name, value]) => `${name}: ${name === 'authorization' ? '[redacted]' : value}`,
    )
    lines.push(`--> ${request.method} ${pathname} ${headers.join('; ')}`)

    const response = await next(request)
    const json = response.headers.get('content-type')?.startsWith('application/json') ?? false
    const body = json ? `${(await response.clone().arrayBuffer()).byteLength} bytes` : 'not read'
    lines.push(`<-- ${response.status} ${pathname} ${body}`)

    return response
  }
}

/** Keeps a GET's body under its ETag, revalidates it, and serves it again on a 304. */
export function etagCache(): Interceptor {
  const cache = new Map<string, { etag: string; body: string; headers: Headers }>()

  return async (request, next) => {
    const cached = request.method === 'GET' ? cache.get(request.url) : undefined
    if (cached !== undefined) {
      request.headers.set('if-none-match', cached.etag)
    }

    const response = await next(request)
    if (response.status === 304 && cached !== undefined) {
      return new Response(cached.body, { status: 200, headers: cached.headers })
    }

    const etag = response.headers.get('etag')
    if (request.method === 'GET' && response.ok && etag !== null) {
      cache.set(request.url, { etag, body: await response.clone().text(), headers: new Headers(response.headers) })
    }

    return response
  }
}

/** Signs the method, the path with its query, and the body's SHA-256, read from a clone so the request keeps it. */
export function signing(key: string): Interceptor {
  return async (request, next) => {
    const encoder = new TextEncoder()
    const { pathname, search } = new URL(request.url)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await request.clone().arrayBuffer()))
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
    const secret = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    const signature = await crypto.subtle.sign(
      'HMAC',
      secret,
      encoder.encode(`${request.method}\n${pathname}${search}\n${hex}`),
    )
    request.headers.set(
      'x-signature',
      Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join(''),
    )

    return next(request)
  }
}

export class ErrUpstream extends Error {
  constructor(readonly status: number) {
    super(`The upstream failed with ${status}`)
    this.name = 'ErrUpstream'
  }
}

/** Rejects with an error of the team's own on a server failure; a refusal stays a response the caller reads. */
export function mapErrors(): Interceptor {
  return async (request, next) => {
    const response = await next(request)
    if (response.status >= 500) {
      await response.body?.cancel()
      throw new ErrUpstream(response.status)
    }
    return response
  }
}
