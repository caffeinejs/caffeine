import { errMessage } from '@caffeinejs/std/err'
import FindMyWay from 'find-my-way'

import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { ErrRouteConflict, type RouteMatcherFactory } from './matcher.js'

// find-my-way calls a handler per match from `lookup` only; the engine reads the store `find` hands back.
const NOOP = (): undefined => undefined

/**
 * The default matcher: find-my-way, built with the server's router flags. It generates code with `new Function`, so
 * it runs where a runtime allows that.
 */
export const findMyWayMatcher: RouteMatcherFactory = <S>(flags: Parameters<RouteMatcherFactory>[0]) => {
  const router = FindMyWay({
    ...flags,
    // The query is parsed on first read, not on every match.
    querystringParser: (query: string) => query as unknown as Record<string, string>,
    // Set so a URL that cannot be decoded comes back as a result with no store, told apart from no route.
    onBadUrl: NOOP,
  } as FindMyWay.Config<FindMyWay.HTTPVersion.V1>)

  return {
    add(method, path, constraints, store) {
      const refused = starParameterRefusal(path)
      if (refused !== undefined) {
        throw refused
      }

      try {
        router.on(
          method as FindMyWay.HTTPMethod,
          path,
          constraints === undefined ? {} : { constraints: { ...constraints } },
          NOOP,
          store,
        )
      } catch (err) {
        throw registrationError(method, path, err)
      }
    },

    match(method, path, constraints) {
      const found = router.find(method as FindMyWay.HTTPMethod, path, constraints)

      if (found === null) {
        return null
      }

      if (found.store === null) {
        throw new ErrHTTPBadRequest(`Cannot route "${path}": the path is not a valid URL`)
      }

      return {
        store: found.store as S,
        params: found.params,
        query: found.searchParams as unknown as string,
      }
    },
  }
}

// find-my-way reports a taken route with a plain `Error` whose message starts with `Method '`, and a path, method or
// pattern it cannot register with an assertion or another error. The assertion is checked first: an unknown method
// is asserted with a message that starts the same way.
function registrationError(method: string, path: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)

  if ((err as { code?: unknown } | null)?.code !== 'ERR_ASSERTION' && message.startsWith("Method '")) {
    return new ErrRouteConflict(
      errMessage(`Cannot register "${method} ${path}": a route with this method and path is already registered`)
        .solutions('Remove one of the two routes, or give one another path or method')
        .reference('@caffeinejs/http', ErrRouteConflict)
        .build(),
    )
  }

  return new ErrConfiguration(
    errMessage(`Cannot register "${method} ${path}": ${message}`)
      .solutions('Fix the method or the path the route declares')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/**
 * Why the route `url` cannot register, when it declares a parameter named `*`: find-my-way gives the wildcard's value
 * that name, so whoever reads `params['*']` could not tell the two apart. `::` is an escaped colon, and the regular
 * expression a parameter may carry, in parentheses, is not read for parameters.
 */
export function starParameterRefusal(url: string): ErrConfiguration | undefined {
  // The router registers the full form of a terminal optional parameter with the question mark removed.
  const path = url.replace(/(\/:[^/()]*?)\?(\/?)$/, '$1$2')

  for (let i = 0; i < path.length; i++) {
    if (path[i] !== ':') {
      continue
    }

    if (path[i + 1] === ':') {
      i++
      continue
    }

    let end = i + 1

    while (end < path.length && !'/-.('.includes(path[end]!)) {
      end++
    }

    if (path.slice(i + 1, end) === '*') {
      return new ErrConfiguration(
        errMessage(`Cannot register "${url}": a parameter named "*" reads as a wildcard, whose value has that name`)
          .solutions('Name the parameter, such as ":name"', 'Write a wildcard as "*", without ":"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    i = path[end] === '(' ? closingParenthesis(path, end) : end - 1
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
