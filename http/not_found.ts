import type { FastifyInstance, FastifyRequest } from 'fastify'

import { ErrHTTPNotFound } from './error/http.js'

/**
 * Installs the root not-found handler, which turns an unmatched URL into {@link ErrHTTPNotFound}.
 *
 * Throwing rather than replying is what puts an unmatched URL through the application's error handling, so a
 * global `@Catch(ErrHTTPNotFound)` sees it and the body matches a 404 a handler threw.
 *
 * Fastify allows one not-found handler per encapsulation context. A handler already set on the server — by a
 * plugin, or on a Fastify instance the caller brought — stands, and nothing is installed. Such a handler throws
 * {@link ErrHTTPNotFound} for the requests it does not answer, or those requests bypass `@Catch`.
 */
export function installNotFoundHandler(server: FastifyInstance): void {
  try {
    server.setNotFoundHandler(async (req: FastifyRequest): Promise<never> => {
      throw new ErrHTTPNotFound(`Route ${req.method}:${req.url} not found`)
    })
  } catch (error) {
    if (!isAlreadySetError(error)) {
      throw error
    }
  }
}

/** Fastify's duplicate-handler guard throws a bare `Error`, identifiable only by its message. */
function isAlreadySetError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Not found handler already set')
}
