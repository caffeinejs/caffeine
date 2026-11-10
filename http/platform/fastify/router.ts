import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance } from 'fastify'

import { ErrConfiguration } from '../../core/error/common.js'

/** How a server's router matches a request's path. */
export interface RouterFlags {
  readonly caseSensitive: boolean
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  /** Whether `;` starts the query, as `?` does. */
  readonly useSemicolonDelimiter: boolean
}

const kRouterFlags = Symbol('@caffeinejs/http:router-flags')

// find-my-way's own defaults, which Fastify keeps.
const DEFAULTS: RouterFlags = {
  caseSensitive: true,
  ignoreTrailingSlash: false,
  ignoreDuplicateSlashes: false,
  useSemicolonDelimiter: false,
}

/**
 * How the router of `server` matches a request's path, as Fastify resolved its options.
 *
 * Not `initialConfig`: a `routerOptions` object there gives each flag it leaves out its default, over the top-level
 * flag of the same name, which Fastify's router still reads.
 *
 * @throws ErrConfiguration on a server the adapter did not build.
 */
export function routerFlagsOf(server: FastifyInstance): RouterFlags {
  const flags = (server as unknown as Record<symbol, RouterFlags | undefined>)[kRouterFlags]

  if (flags === undefined) {
    throw notBuilt('read the router flags')
  }

  return flags
}

/**
 * Records on `server` the flags its router was built with from `options`, as Fastify reads them: a key `routerOptions`
 * holds first, then the top-level one, then the default.
 */
export function recordRouterFlags(server: FastifyInstance, options: object): void {
  const top = options as Partial<Record<keyof RouterFlags, boolean>> & { routerOptions?: object | null }
  const nested = (top.routerOptions ?? {}) as Partial<Record<keyof RouterFlags, boolean>>
  const flag = (name: keyof RouterFlags): boolean =>
    (Object.hasOwn(nested, name) ? nested[name] : top[name]) ?? DEFAULTS[name]

  server.decorate(kRouterFlags, {
    caseSensitive: flag('caseSensitive'),
    ignoreTrailingSlash: flag('ignoreTrailingSlash'),
    ignoreDuplicateSlashes: flag('ignoreDuplicateSlashes'),
    useSemicolonDelimiter: flag('useSemicolonDelimiter'),
  } satisfies RouterFlags)
}

function notBuilt(action: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot ${action}: the server was not built by the Caffeine adapter`)
      .solutions('Call it from a plugin registered with ".with(...)" on the application')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
