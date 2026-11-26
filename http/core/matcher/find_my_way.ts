import { errMessage } from '@caffeinejs/std/err'
import FindMyWay from 'find-my-way'

import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { parseRoutePattern } from '../routing/paths.js'
import { ErrRouteConflict, type DerivedConstraints, type RouteMatcherFactory, type RouterFlags } from './matcher.js'

// find-my-way calls a handler per match from `lookup` only; the engine reads the store `find` hands back.
const NOOP = (): undefined => undefined

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The default matcher: find-my-way, built with the server's router flags. It generates code with `new Function`, so
 * it runs where a runtime allows that.
 */
export const findMyWayMatcher: RouteMatcherFactory = <S>(
  flags: Parameters<RouteMatcherFactory>[0],
  strategies: Parameters<RouteMatcherFactory>[1],
) => {
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

  const router = routerOf(flags, strategies)

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
        throw registrationError(method, path, constraints, err)
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

// One server's find-my-way, built with its router flags and the custom strategies.
function routerOf(
  flags: RouterFlags,
  strategies: readonly ConstraintStrategy<unknown>[],
): FindMyWay.Instance<FindMyWay.HTTPVersion.V1> {
  return FindMyWay({
    // The one flag the router takes: find-my-way's other options keep their defaults, whatever `flags` carries.
    ignoreTrailingSlash: flags.ignoreTrailingSlash,
    constraints: Object.fromEntries(strategies.map(strategy => [strategy.name, findMyWayStrategy(strategy, NOOP)])),
    // The query is parsed on first read, not on every match.
    querystringParser: (query: string) => query as unknown as Record<string, string>,
    // Set so a URL that cannot be decoded comes back as a result with no store, told apart from no route.
    onBadUrl: NOOP,
  } as FindMyWay.Config<FindMyWay.HTTPVersion.V1>)
}

// find-my-way's own: a path ending in an optional parameter registers twice, with it and without it.
const OPTIONAL_PARAMETER = /(\/:[^/()]*?)\?(\/?)/

/**
 * The paths `on` registers `path` as, rewritten as it rewrites them: `findRoute` reads a path as written, so the table
 * rewrites it first.
 */
function formsOf(path: string, flags: RouterFlags): string[] {
  if (OPTIONAL_PARAMETER.test(path)) {
    return [
      ...formsOf(path.replace(OPTIONAL_PARAMETER, '$1$2'), flags),
      ...formsOf(path.replace(OPTIONAL_PARAMETER, '$2') || '/', flags),
    ]
  }

  return [flags.ignoreTrailingSlash ? FindMyWay.trimLastSlash(path) : path]
}

/** Routes by method and path alone: those find-my-way takes for one route, filed together. */
export interface PreflightTable<S> {
  add(method: string, path: string, store: S): void
  /** Every store filed where `method` and `url` match; `undefined` for none, and for a URL that cannot be decoded. */
  match(method: string, url: string): readonly S[] | undefined
}

/**
 * The table a preflight is looked up in, built with the server's router flags. `findRoute` finds the route a path is
 * filed under as find-my-way's own conflict check does: parameter names erased.
 */
export function preflightTable<S>(flags: RouterFlags): PreflightTable<S> {
  const router = routerOf(flags, [])

  return {
    add(method, path, store) {
      for (const form of formsOf(path, flags)) {
        const found = router.findRoute(method as FindMyWay.HTTPMethod, form)
        if (found === null) {
          router.on(method as FindMyWay.HTTPMethod, form, NOOP, [store])
        } else {
          ;(found.store as S[]).push(store)
        }
      }
    },

    match(method, url) {
      // A URL that cannot be decoded comes back with no store: it names no route either.
      return (router.find(method as FindMyWay.HTTPMethod, url)?.store as S[] | null | undefined) ?? undefined
    },
  }
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

/**
 * Why the route `url` cannot register, when it declares a parameter named `*`: find-my-way gives the wildcard's value
 * that name, so whoever reads `params['*']` could not tell the two apart.
 *
 * @throws ErrConfiguration when the route path cannot be read.
 */
export function starParameterRefusal(url: string): ErrConfiguration | undefined {
  if (!parseRoutePattern(url).some(part => part.kind === 'param' && part.name === '*')) {
    return undefined
  }

  return new ErrConfiguration(
    errMessage(`Cannot register "${url}": a parameter named "*" reads as a wildcard, whose value has that name`)
      .solutions('Name the parameter, such as ":name"', 'Write a wildcard as "*", without ":"')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
