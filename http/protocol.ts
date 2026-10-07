import type { FastifyRequest } from 'fastify'

/**
 * The request's scheme, lower-cased: what the socket says, or `X-Forwarded-Proto` behind a proxy the server was told
 * to trust. Empty when neither says.
 *
 * The one reader of Fastify's `request.protocol`, which carries the proxy's header as written (`HTTPS`) and is
 * `undefined` without a socket.
 */
export function protocolOf(request: FastifyRequest): string {
  return (request.protocol ?? '').toLowerCase()
}
