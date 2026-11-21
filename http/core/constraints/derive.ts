import { errMessage } from '@caffeinejs/std/err'

import { appendVary, type VaryReply } from '../../vary.js'
import { ErrConfiguration } from '../error/common.js'
import type { DerivedConstraints } from '../matcher/matcher.js'
import type { IRoute, IRouteGroup } from '../routing/route.js'
import type { ConstraintRequest, ConstraintStrategy } from './constraints.js'
import { kVersionHeader, VERSION_CONSTRAINT } from './keys.js'

// The constraints find-my-way matches without a strategy, and the header each reads.
const BUILT_IN: ReadonlyMap<string, string> = new Map([
  [VERSION_CONSTRAINT, kVersionHeader],
  ['host', 'host'],
])

// What a request deriving nothing hands the matcher, which only reads it.
const NONE: DerivedConstraints = Object.freeze({})

/** What a server's routes declare with `constraint()` and `version()`, compiled once. */
export interface CompiledConstraints {
  /**
   * The `onSend` entry adding each header a route declared to `Vary`, first spelling kept; `undefined` when none did.
   * It goes first, so every `onSend` hook sees it, and a miss carries it too.
   */
  readonly vary: ((reply: VaryReply) => void) | undefined
  /** Whether any route declared a constraint: until one does, nothing is derived. */
  readonly derives: boolean
  /** The value of every declared name this request carries; a name it does not carry is left out. */
  derive(req: ConstraintRequest): DerivedConstraints
  /**
   * What one route registers under, `undefined` for none.
   *
   * @throws ErrConfiguration for a declaration that is not a `Map`, or a name no strategy and no built-in matches.
   */
  of(route: IRoute<any>, methods: readonly string[], url: string): DerivedConstraints | undefined
}

/** Compiles what `groups` declare, deriving custom names with `strategies` and the rest with the built-ins. */
export function compileConstraints(
  groups: readonly IRouteGroup<any>[],
  strategies: readonly ConstraintStrategy<unknown>[],
): CompiledConstraints {
  const names = new Set<string>()
  // By lower-cased name, the first spelling kept.
  const headers = new Map<string, string>()

  for (const group of groups) {
    for (const route of group.routes) {
      const declared = route.options.constraints
      if (!(declared instanceof Map)) {
        continue
      }

      for (const [name, { header }] of declared) {
        names.add(name)
        if (header !== undefined && !headers.has(header.toLowerCase())) {
          headers.set(header.toLowerCase(), header)
        }
      }
    }
  }

  // Every name a request can derive, a custom strategy replacing the built-in of its name. A declared name missing
  // here is refused by `of`.
  const known = new Map<string, (req: ConstraintRequest) => unknown>()
  for (const [name, header] of BUILT_IN) {
    known.set(name, req => req.header(header))
  }
  for (const strategy of strategies) {
    known.set(strategy.name, req => strategy.deriveConstraint(req))
  }
  const derivers = [...names].flatMap(name => {
    const deriver = known.get(name)
    return deriver === undefined ? [] : [[name, deriver] as const]
  })

  // A cache keyed on the URL alone would serve one client another's answer.
  const varied = [...headers.values()]

  return {
    vary: varied.length === 0 ? undefined : (reply: VaryReply) => appendVary(reply, varied),
    derives: derivers.length > 0,

    derive(req) {
      let derived: Record<string, unknown> | undefined
      for (const [name, deriver] of derivers) {
        const value = deriver(req)
        if (value !== undefined) {
          ;(derived ??= {})[name] = value
        }
      }
      return derived ?? NONE
    },

    of(route, methods, url) {
      const declared = route.options.constraints
      if (declared === undefined || (declared instanceof Map && declared.size === 0)) {
        return undefined
      }

      const where = `${methods.join('|')} ${url}`
      if (!(declared instanceof Map)) {
        throw new ErrConfiguration(
          errMessage(`Cannot serve "${where}": its constraints are not declared with constraint() or version()`)
            .solutions(
              `Declare them with ".routeOptions(constraint(name, value))" or ".routeOptions(version('1.0.0'))"`,
            )
            .reference('@caffeinejs/http', ErrConfiguration)
            .build(),
        )
      }

      const constraints: Record<string, unknown> = {}
      for (const [name, { value }] of declared) {
        if (!known.has(name)) {
          throw new ErrConfiguration(
            errMessage(`Cannot serve "${where}": no constraint strategy is named "${name}"`)
              .solutions(
                `Pass its strategy to ".server(...)": "{ constraints: [strategy] }"`,
                'Remove the constraint from the route',
              )
              .reference('@caffeinejs/http', ErrConfiguration)
              .build(),
          )
        }
        constraints[name] = value
      }

      return constraints
    },
  }
}
