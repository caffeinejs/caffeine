import { errMessage } from '@caffeinejs/std/err'
import FindMyWay from 'find-my-way'

import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { ErrRouteConflict, type DerivedConstraints, type RouteMatcherFactory } from './matcher.js'

// find-my-way calls a handler per match from `lookup` only; the engine reads the store `find` hands back.
const NOOP = (): undefined => undefined

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

// The path a matcher is handed holds no query: find-my-way parses none, and allocates nothing for it.
const NO_QUERY: Record<string, string> = Object.freeze({})

/**
 * The default matcher: find-my-way. It generates code with `new Function`, so it runs where a runtime allows that.
 */
export const findMyWayMatcher: RouteMatcherFactory = <S>(strategies: Parameters<RouteMatcherFactory>[0]) => {
  for (const strategy of strategies) {
    // find-my-way writes the name into the code it generates.
    if (!IDENTIFIER.test(strategy.name)) {
      throw new ErrConfiguration(
        errMessage(`Cannot use the constraint strategy "${strategy.name}": its name is not a JavaScript identifier`)
          .solutions('Name it with letters, digits, "_" and "$", not starting with a digit, such as "tenant"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }

  const router = routerOf(strategies)

  return {
    add(method, path, constraints, store) {
      try {
        router.on(
          method as FindMyWay.HTTPMethod,
          path,
          constraints === undefined ? {} : { constraints: { ...constraints } },
          NOOP,
          store,
        )
      } catch (err) {
        throw registrationError(method, path, constraints, err)
      }
    },

    match(method, path, constraints) {
      const found = router.find(method as FindMyWay.HTTPMethod, path, constraints)

      if (found === null) {
        return null
      }

      // A path `requestPath` read never gets here; a raw one handed straight to the matcher could.
      if (found.store === null) {
        throw new ErrHTTPBadRequest(`Cannot route "${path}": the path is not a valid URL`)
      }

      return { store: found.store as S, params: found.params }
    },
  }
}

// One server's find-my-way, built with the custom strategies.
function routerOf(strategies: readonly ConstraintStrategy<unknown>[]): FindMyWay.Instance<FindMyWay.HTTPVersion.V1> {
  return FindMyWay({
    // A trailing slash never makes another route.
    ignoreTrailingSlash: true,
    constraints: Object.fromEntries(strategies.map(strategy => [strategy.name, findMyWayStrategy(strategy, NOOP)])),
    querystringParser: () => NO_QUERY,
    // Set so a URL that cannot be decoded comes back as a result with no store, told apart from no route.
    onBadUrl: NOOP,
  } as FindMyWay.Config<FindMyWay.HTTPVersion.V1>)
}

/**
 * A copy of `strategy` in find-my-way's shape, which find-my-way may mark; `derive` reads find-my-way's own request.
 */
export function findMyWayStrategy(
  strategy: ConstraintStrategy<unknown>,
  derive: (req: never) => unknown,
): FindMyWay.ConstraintStrategy<FindMyWay.HTTPVersion.V1, unknown> {
  return {
    name: strategy.name,
    mustMatchWhenDerived: strategy.mustMatchWhenDerived,
    storage: strategy.storage.bind(strategy),
    validate: strategy.validate?.bind(strategy),
    deriveConstraint: derive,
  } as FindMyWay.ConstraintStrategy<FindMyWay.HTTPVersion.V1, unknown>
}

// find-my-way reports a taken route with a plain `Error` whose message starts with `Method '`, and a path, method or
// pattern it cannot register with an assertion or another error. The assertion is checked first: an unknown method
// is asserted with a message that starts the same way.
function registrationError(
  method: string,
  path: string,
  constraints: DerivedConstraints | undefined,
  err: unknown,
): Error {
  const message = err instanceof Error ? err.message : String(err)

  if ((err as { code?: unknown } | null)?.code !== 'ERR_ASSERTION' && message.startsWith("Method '")) {
    const under =
      constraints === undefined
        ? ''
        : ` for ${Object.entries(constraints)
            .map(([name, value]) => `${name} "${spelled(value)}"`)
            .join(' and ')}`
    const taken = constraints === undefined ? 'method and path' : 'method, path and constraints'
    const other = constraints === undefined ? 'path or method' : 'path, method or constraint value'

    return new ErrRouteConflict(
      errMessage(`Cannot register "${method} ${path}"${under}: a route with this ${taken} is already registered`)
        .solutions(`Remove one of the two routes, or give one another ${other}`)
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

// A constraint value as a message names it: a pattern and a scalar as written, an object as JSON.
function spelled(value: unknown): string {
  return typeof value === 'object' && value !== null && !(value instanceof RegExp)
    ? JSON.stringify(value)
    : String(value)
}
