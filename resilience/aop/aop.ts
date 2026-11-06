import { $aop, type AnyClass, type JoinPoint, type MethodAspect, type Pointcut, reflect } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { compose, lift, signalIndex, withSignal } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { fallback } from '../fallback/fallback.js'
import type { Operation, PolicyLike } from '../policy.js'
import { ANNOTATIONS, Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from './annotations.js'
import { kAddFallback, labelOf, type ResilienceKind, type ResilienceRegistry } from './registry.js'

type Member = string | symbol

/** Where the resilience aspect sits among aspects: outside every aspect with a positive order or none. */
export const RESILIENCE_ASPECT_ORDER = 0

function annotated(cls: AnyClass, member: Member): boolean {
  for (const annotation of ANNOTATIONS.keys()) {
    if (reflect.effective(cls, annotation, member) !== undefined) {
      return true
    }
  }
  return false
}

function annotatedMembers(cls: AnyClass): Set<Member> {
  const members = new Set<Member>()
  for (const annotation of ANNOTATIONS.keys()) {
    for (const member of reflect.members(cls, annotation).keys()) {
      members.add(member)
    }
  }
  return members
}

/** Every method that carries a resilience annotation, in every class the container builds. */
export const resiliencePointcut: Pointcut = $aop.pointcut(
  (_descriptor, cls) => annotatedMembers(cls).size > 0,
  (member, _descriptor, cls) => annotated(cls, member),
)

// What one method runs through, built once, the first time it is needed. The join point is the input.
type Plan = Operation<unknown, JoinPoint>

/**
 * Runs each annotated method through its policies, in one fixed order whatever the order of the decorators:
 * fallback, retry, circuit breaker, rate limiter, bulkhead, time limiter.
 *
 * The first argument that is an `AbortSignal` is taken as the caller's signal. Where a time limiter gives the attempt
 * a signal of its own, the method receives that one in its place: it aborts with the caller's too, and stays linked
 * to it after the method returns, so a body it streams still learns that the caller left.
 */
export class ResilienceAspect implements MethodAspect {
  readonly #registry: ResilienceRegistry
  readonly #plans = new WeakMap<AnyClass, Map<Member, Plan>>()

  constructor(registry: ResilienceRegistry) {
    this.#registry = registry
  }

  /**
   * Builds the plan of every annotated method of `cls`.
   *
   * @throws {@link ErrInvalidOption} when a method names an instance nothing defines, a `@Fallback` names a method
   * `cls` lacks, or an annotation is on a static or a private method.
   */
  prepare(cls: AnyClass): void {
    for (const [annotation, decorator] of ANNOTATIONS) {
      const member = reflect.members(cls, annotation, { static: true }).keys().next().value
      if (member !== undefined) {
        throw new ErrInvalidOption(
          errMessage(
            `Cannot weave "${cls.name}.${String(member)}": @${decorator} is on a static method, which is never woven`,
          )
            .solutions(`Move @${decorator} to an instance method of "${cls.name}"`)
            .reference('@caffeinejs/resilience', ErrInvalidOption)
            .build(),
        )
      }
    }

    for (const [annotation, decorator] of ANNOTATIONS) {
      for (const member of reflect.members(cls, annotation).keys()) {
        // A private method is called by name inside its class, never through a property a weave could replace.
        if (typeof (cls.prototype as Record<Member, unknown>)[member] !== 'function') {
          throw new ErrInvalidOption(
            errMessage(
              `Cannot weave "${cls.name}.${String(member)}": @${decorator} is on a private method, which is never woven`,
            )
              .solutions(`Make "${String(member)}" a public method of "${cls.name}"`)
              .reference('@caffeinejs/resilience', ErrInvalidOption)
              .build(),
          )
        }
      }
    }

    for (const member of annotatedMembers(cls)) {
      this.#plan(cls, member)
    }
  }

  around(jp: JoinPoint): unknown {
    let plan: Plan
    try {
      plan = this.#plan(jp.ctor as AnyClass, jp.methodName)
    } catch (error) {
      // The method returns a promise, so a plan that cannot be built rejects it rather than throwing.
      return Promise.reject(error)
    }

    const signal = jp.args[signalIndex(jp.args)] as AbortSignal | undefined
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(signal.reason)
    }
    return plan({ signal }, jp)
  }

  #plan(cls: AnyClass, member: Member): Plan {
    let plans = this.#plans.get(cls)
    if (plans === undefined) {
      plans = new Map()
      this.#plans.set(cls, plans)
    }

    let plan = plans.get(member)
    if (plan === undefined) {
      plan = this.#build(cls, member)
      plans.set(member, plan)
    }
    return plan
  }

  #build(cls: AnyClass, member: Member): Plan {
    const where = `${cls.name}.${String(member)}`
    const named = (kind: ResilienceKind, decorator: string, name: string | undefined): PolicyLike | undefined => {
      if (name === undefined) {
        return undefined
      }
      if (!this.#registry.has(kind, name)) {
        throw new ErrInvalidOption(
          errMessage(`Cannot weave "${where}": no ${labelOf(kind)} named "${name}" is defined`)
            .solutions(
              `Define it with Resilience(r => r.${kind}('${name}', { ... }))`,
              `Fix the name in @${decorator}('${name}')`,
            )
            .reference('@caffeinejs/resilience', ErrInvalidOption)
            .build(),
        )
      }
      return this.#registry[kind](name)
    }

    // Outermost first: retry, circuit breaker, rate limiter, bulkhead, time limiter. The time limiter sits inside the
    // bulkhead so it times the running call, not the wait for a slot, which the bulkhead bounds and refuses itself.
    const policies = [
      named('retry', 'Retry', reflect.effective(cls, Retry, member)?.name),
      named('circuitBreaker', 'CircuitBreaker', reflect.effective(cls, CircuitBreaker, member)),
      named('rateLimiter', 'RateLimiter', reflect.effective(cls, RateLimiter, member)),
      named('bulkhead', 'Bulkhead', reflect.effective(cls, Bulkhead, member)),
      named('timeLimiter', 'TimeLimiter', reflect.effective(cls, TimeLimiter, member)),
    ].filter((policy): policy is PolicyLike => policy !== undefined)

    const method = lift<unknown, JoinPoint>(
      (ctx, jp) => jp.proceed(...withSignal(jp.args as unknown[], ctx.signal, undefined)) as Promise<unknown>,
    )
    const recovery = reflect.effective(cls, Fallback, member)
    if (recovery === undefined) {
      return compose(...policies)(method)
    }

    if (typeof (cls.prototype as Record<Member, unknown>)[recovery.method] !== 'function') {
      throw new ErrInvalidOption(
        errMessage(
          `Cannot weave "${where}": @Fallback names "${String(recovery.method)}", which is not a method of "${cls.name}"`,
        )
          .solutions(`Add a method "${String(recovery.method)}(error, ...args)" to "${cls.name}", or fix the name`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const answer = fallback(
      (error, jp) => {
        const { target, args } = jp as JoinPoint
        return (target as Record<Member, (...args: unknown[]) => unknown>)[recovery.method]!(error, ...args)
      },
      { name: where, on: recovery.on },
    )
    this.#registry[kAddFallback](answer)
    return compose(answer, ...policies)(method)
  }
}
