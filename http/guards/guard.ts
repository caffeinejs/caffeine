import { Ctor } from '@caffeinejs/di'
import type { Context } from '../context.js'

export class GuardResult {
  constructor(readonly ok: boolean, readonly reason: string) {}

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

export type GuardOptions<T = unknown> = T

export interface GuardTarget {
  clazz: Ctor<unknown>
  handler: string | symbol
}

export interface GuardInput<T = unknown> {
  context: GuardContext
  target: GuardTarget
  opts: GuardOptions<T>
}

/**
 * A request predicate resolved from the container and run on Fastify `onRequest`.
 *
 * Return `true` (or `{ ok: true }`) to continue. Return `false` or `{ ok: false, reason }` to deny
 * with 403. Throw `ErrHTTPUnauthorized` (or any other `ErrHTTP`) for a different status — those go
 * through `@Catch`.
 */
export abstract class Guard {
  abstract canActivate(input: GuardInput): GuardReturn
}
