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

/**
 * Why the route `url` cannot register, when it declares a parameter named `*`: find-my-way gives the wildcard's value
 * that name, so whoever reads `params['*']` could not tell the two apart. `::` is an escaped colon, and the regular
 * expression a parameter may carry, in parentheses, is not read for parameters.
 */
export function starParameterRefusal(url: string): ErrConfiguration | undefined {
  for (let i = 0; i < url.length; i++) {
    if (url[i] !== ':') {
      continue
    }

    if (url[i + 1] === ':') {
      i++
    } else if (url[i + 1] !== '*') {
      // The name runs to the next separator; a regular expression may follow it at once.
      let end = i + 1

      while (end < url.length && !'/-.:('.includes(url[end]!)) {
        end++
      }

      i = url[end] === '(' ? closingParenthesis(url, end) : end - 1
    } else {
      return new ErrConfiguration(
        errMessage(`Cannot register "${url}": a parameter named "*" reads as a wildcard, whose value has that name`)
          .solutions('Name the parameter, such as ":name"', 'Write a wildcard as "*", without ":"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }

  return undefined
}

/** The index of the `)` closing the `(` at `open`, nested ones and escaped ones aside, or the end of `url`. */
function closingParenthesis(url: string, open: number): number {
  let depth = 0

  for (let i = open; i < url.length; i++) {
    if (url[i] === '\\') {
      i++
    } else if (url[i] === '(') {
      depth++
    } else if (url[i] === ')' && --depth === 0) {
      return i
    }
  }

  return url.length
}

function notBuilt(action: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot ${action}: the server was not built by the Caffeine adapter`)
      .solutions('Call it from a plugin registered with ".with(...)" on the application')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
