import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Context } from './context.js'
import { ErrCaffeineWebApplication } from './error/common.js'
import { ErrHTTPNotFound } from './error/http.js'
import { solutions } from './error/util.js'
import { joinPaths } from './internal/paths/paths.js'
import type { RouteGroup } from './route.js'
import type { ServerExtensionContext } from './server_extension.js'
import { ServerOwnedPaths, serverOwnedPaths } from './server_owned_paths.js'

/**
 * What a fallback is told about the request that matched no route.
 */
export interface NotFoundContext {
  readonly http: Context
  /** The request path, query string already stripped. */
  readonly path: string
  /**
   * Whether `path` lies under a prefix the server owns — a controller's base path or a health probe.
   *
   * A fallback that serves a single-page application's shell uses this to keep API misses as API misses:
   * `GET /api/typo` is a 404, not an HTML document, even though no route matched either one.
   */
  readonly serverOwned: boolean
}

/**
 * A candidate responder for a request that matched no route.
 *
 * Fastify keeps not-found and `setErrorHandler` as separate pipelines, and allows exactly one not-found
 * handler per encapsulation context. That single seat is why an application wanting a history fallback had to
 * take it and hand-roll everything else. `http` holds it instead and offers this: fallbacks run in the order
 * they were bound, and the first to return `true` owns the response. When none does, the request becomes an
 * {@link ErrHTTPNotFound} and flows through the normal `@Catch` pipeline, so an unmatched URL renders with the
 * same body as a 404 a handler threw.
 *
 * Bind one with `container.bind(MyFallback).toClass(MyFallback).extends()`.
 *
 * **This is not a middleware.** The `handler` middleware group wraps a controller dispatch, and an unmatched
 * URL has no controller to wrap.
 */
export abstract class NotFoundFallback {
  /** Identifies the fallback in start-up diagnostics. */
  abstract readonly name: string

  /** Returns `true` when it answered the request, `false` to let the next fallback try. */
  abstract handle(ctx: NotFoundContext): boolean | Promise<boolean>
}

/**
 * The static path prefixes the server owns, derived from the resolved routing.
 *
 * Derived rather than configured because a hand-written exclude list drifts the moment a controller is added
 * or renamed, and nothing reports it — the application keeps booting and starts answering an API miss with an
 * HTML document.
 *
 * A controller contributes its **base** path (`@Prefix` + `@Controller`), not its individual route URLs:
 * `@Controller('/api')` declaring only `@Get('/')` owns all of `/api`, so `/api/typo` stays a 404 instead of
 * falling through to a shell. A base that is empty or `/` would own the whole origin and leave a fallback
 * nothing to answer, so those controllers contribute their route paths instead.
 *
 * Paths are truncated at the first dynamic segment, since `/users/:id` tells us the server owns `/users`.
 */
export function deriveServerOwnedPaths(
  routeGroups: readonly RouteGroup<any>[],
  extraPaths: readonly string[] = [],
): string[] {
  const owned = new Set<string>()

  for (const router of routeGroups) {
    const base = staticPrefix(`${router.prefix ?? ''}${router.path}`)

    if (base !== '' && base !== '/') {
      owned.add(base)
      continue
    }

    // A controller mounted at the root owns no prefix of its own, so it speaks for its routes individually.
    for (const route of router.routes) {
      const path = staticPrefix(`${router.prefix ?? ''}${joinPaths(router.path, route.path)}`)

      if (path !== '' && path !== '/') {
        owned.add(path)
      }
    }
  }

  for (const path of extraPaths) {
    const extra = staticPrefix(path)

    if (extra !== '' && extra !== '/') {
      owned.add(extra)
    }
  }

  return [...owned].sort()
}

/**
 * Whether `path` falls under one of `owned`.
 *
 * Segment-aware on purpose: a plain `startsWith` would put `/apifoo` under `/api`.
 */
export function isServerOwned(owned: readonly string[], path: string): boolean {
  return owned.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Installs the root not-found handler: the fallback chain first, then {@link ErrHTTPNotFound}.
 *
 * Throwing rather than replying is what puts an unmatched URL through the application's error handling, so a
 * global `@Catch(ErrHTTPNotFound)` sees it and the body matches a 404 a handler threw.
 */
export function installNotFoundHandler(ctx: ServerExtensionContext, fallbacks: readonly NotFoundFallback[]): void {
  const owned = deriveServerOwnedPaths(
    ctx.routeGroups,
    serverOwnedPaths(ctx.container.getManyOptional(ServerOwnedPaths)),
  )

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<never | FastifyReply> => {
    const path = req.url.split('?')[0] ?? ''

    if (fallbacks.length > 0) {
      const notFoundContext: NotFoundContext = {
        http: req.httpContext,
        path,
        serverOwned: isServerOwned(owned, path),
      }

      for (const fallback of fallbacks) {
        if (await fallback.handle(notFoundContext)) {
          return reply
        }
      }
    }

    throw new ErrHTTPNotFound(`Route ${req.method}:${req.url} not found`)
  }

  // A caller that brings its own Fastify instance may have set a not-found handler on it already, and Fastify
  // allows only one per encapsulation context. Theirs is an explicit choice, so it stands — but a fallback
  // then never runs, and a single-page application that silently stops serving its shell is worse than a
  // start-up failure, so that combination is refused instead.
  try {
    ctx.server.setNotFoundHandler(handler)
  } catch (error) {
    if (!isAlreadySetError(error)) {
      throw error
    }

    if (fallbacks.length > 0) {
      throw new ErrNotFoundHandlerAlreadySet(fallbacks.map(fallback => fallback.name))
    }

    ctx.server.log.warn(
      'A not-found handler was already set on the Fastify instance, so Caffeine did not install its own: ' +
        'unmatched routes bypass the error pipeline and will not be seen by @Catch',
    )
  }
}

/**
 * ErrNotFoundHandlerAlreadySet is thrown at start-up when the application both sets its own Fastify
 * not-found handler and registers a {@link NotFoundFallback}.
 *
 * Fastify allows one not-found handler per encapsulation context, so the two cannot coexist: the fallback
 * would never run and whatever it serves — most often a single-page application's shell — would quietly stop
 * being served. Reported here rather than at the first 404 that goes to the wrong place.
 */
export class ErrNotFoundHandlerAlreadySet extends ErrCaffeineWebApplication {
  constructor(fallbackNames: readonly string[]) {
    super(
      `Cannot install the not-found handler: one is already set on the Fastify instance, and it would ` +
        `prevent the registered fallbacks from running: "${fallbackNames.join('", "')}"` +
        solutions(
          'Remove the setNotFoundHandler call and express the same logic as a NotFoundFallback',
          'Remove the fallback registration if the hand-written handler is the one that should win',
        ),
      'ERR_NOT_FOUND_HANDLER_ALREADY_SET',
    )
    this.name = 'ErrNotFoundHandlerAlreadySet'
  }
}

/** Fastify's duplicate-handler guard throws a bare `Error`, identifiable only by its message. */
function isAlreadySetError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Not found handler already set')
}

/** The leading static portion of a route path — everything before the first `:param` or `*` segment. */
function staticPrefix(path: string): string {
  // A controller mounted at '/' joins to '//health', since joinPaths only concatenates.
  const segments = path.replace(/\/{2,}/g, '/').split('/')
  const stable: string[] = []

  for (const segment of segments) {
    if (segment.startsWith(':') || segment.startsWith('*')) {
      break
    }

    stable.push(segment)
  }

  const joined = stable.join('/')

  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}
