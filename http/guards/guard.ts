import { Ctor } from '@caffeinejs/di'
import type { BaseGuard, GuardDenial, GuardOutcome } from '@caffeinejs/std/framework'

import type { Context } from '../context.js'
import { ErrHTTPForbidden, ErrHTTPUnauthorized } from '../error/http.js'

export class GuardResult implements GuardOutcome {
  constructor(
    readonly ok: boolean,
    readonly reason: string,
    readonly unauthenticated?: boolean,
  ) {}

  static ok(): GuardResult {
    return new GuardResult(true, '')
  }

  static deny(reason: string): GuardResult {
    return new GuardResult(false, reason)
  }

  /** Denies with 401 rather than 403: the caller is not known, rather than known and not allowed. */
  static unauthenticated(reason: string): GuardResult {
    return new GuardResult(false, reason, true)
  }
}

export type GuardReturn = boolean | GuardResult | Promise<boolean | GuardResult>

export type GuardContext<C extends Context = Context> = Omit<C, 'req'> & {
  readonly req: Omit<C['req'], 'body'>
}

export interface GuardTarget {
  /** The class that declared the route, when a class did. A route declared without one leaves it undefined. */
  readonly clazz?: Ctor<unknown>
  readonly handler: string | symbol
}

export interface GuardInput {
  /** Always `'http'`. A guard that also implements another transport's guard interface narrows on it. */
  readonly kind: 'http'
  context: GuardContext
  target: GuardTarget
}

/**
 * A request predicate resolved from the container and run before the request body is read.
 *
 * Return `true` (or `{ ok: true }`) to continue. Return `false` or `{ ok: false, reason }` to deny with 403,
 * and {@link GuardResult.unauthenticated} to deny with 401. Throw any other `ErrHTTP` for a different status —
 * those go through `@Catch`.
 */
export interface Guard extends BaseGuard<GuardInput> {
  guard(input: GuardInput): GuardReturn
}

const RESOURCE_FORBIDDEN = 'Resource forbidden'

export const httpGuardDenial: GuardDenial = (outcome, reason) =>
  outcome === 'unauthenticated'
    ? new ErrHTTPUnauthorized(reason || undefined)
    : new ErrHTTPForbidden(reason || RESOURCE_FORBIDDEN)
