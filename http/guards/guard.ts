import { Ctor } from '@caffeinejs/di'

import type { Context } from '../context.js'

export class GuardResult {
  constructor(
    readonly ok: boolean,
    readonly reason: string,
  ) {}

  static ok(): GuardResult {
    return new GuardResult(true, '')
  }

  static deny(reason: string): GuardResult {
    return new GuardResult(false, reason)
  }
}

export type GuardReturn = boolean | GuardResult | Promise<boolean | GuardResult>

export type GuardContext<C extends Context = Context> = Omit<C, 'req'> & {
  readonly req: Omit<C['req'], 'body'>
}

export interface GuardTarget {
  /** The class that declared the route, when a class did. A route declared without one leaves it undefined. */
  clazz?: Ctor<unknown>
  handler: string | symbol
}

export interface GuardInput {
  context: GuardContext
  target: GuardTarget
}

/**
 * A request predicate resolved from the container and run on Fastify `onRequest`.
 *
 * Return `true` (or `{ ok: true }`) to continue. Return `false` or `{ ok: false, reason }` to deny
 * with 403. Throw `ErrHTTPUnauthorized` (or any other `ErrHTTP`) for a different status — those go
 * through `@Catch`.
 */
export interface Guard {
  guard(input: GuardInput): GuardReturn
}
