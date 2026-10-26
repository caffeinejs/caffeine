import { $aop, type AnyClass, type JoinPoint, type MethodAspect, type Pointcut, reflect } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { compose } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { type Fallback as FallbackPolicy, fallback } from '../fallback/fallback.js'
import type { Resilient, Strategy } from '../strategy.js'
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

// What one method runs through, built once, the first time it is needed.
interface Plan {
  readonly run: Resilient
  readonly fallback: { readonly method: Member; readonly policy: FallbackPolicy } | undefined
}

/**
 * Runs each annotated method through its strategies, in one fixed order whatever the order of the decorators:
 * fallback, retry, circuit breaker, rate limiter, bulkhead, time limiter.
 *
 * The first argument that is an `AbortSignal` is taken as the caller's signal, and each attempt receives the
 * attempt's signal in its place.
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
   * `cls` lacks, or an annotation is on a static method.
   */
  prepare(cls: AnyClass): void {
    for (const [annotation, decorator] of ANNOTATIONS) {
      const [member] = reflect.members(cls, annotation, { static: true }).keys()
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
    const args = jp.args

    let at = -1
    for (let i = 0; i < args.length; i++) {
      if (args[i] instanceof AbortSignal) {
        at = i
        break
      }
    }
    const signal = at === -1 ? undefined : (args[at] as AbortSignal)

    const call = plan.run(ctx => {
      if (at === -1 || ctx.signal === signal) {
        return jp.proceed(...args) as Promise<unknown>
      }

      const attempt = args.slice()
      attempt[at] = ctx.signal
      return jp.proceed(...attempt) as Promise<unknown>
    }, signal)

    if (plan.fallback === undefined) {
      return call
    }

    const { method, policy } = plan.fallback
    const target = jp.target as Record<Member, (...args: unknown[]) => unknown>
    return policy.recover(call, error => target[method]!(error, ...args), signal)
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
    const named = (kind: ResilienceKind, decorator: string, name: string | undefined): Strategy | undefined => {
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
    const strategies = [
      named('retry', 'Retry', reflect.effective(cls, Retry, member)?.name),
      named('circuitBreaker', 'CircuitBreaker', reflect.effective(cls, CircuitBreaker, member)),
      named('rateLimiter', 'RateLimiter', reflect.effective(cls, RateLimiter, member)),
      named('bulkhead', 'Bulkhead', reflect.effective(cls, Bulkhead, member)),
      named('timeLimiter', 'TimeLimiter', reflect.effective(cls, TimeLimiter, member)),
    ].filter((strategy): strategy is Strategy => strategy !== undefined)

    const recovery = reflect.effective(cls, Fallback, member)
    if (recovery === undefined) {
      return { run: compose(...strategies), fallback: undefined }
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

    const policy = fallback({ name: where, fallbackOn: recovery.fallbackOn })
    this.#registry[kAddFallback](policy)
    return { run: compose(...strategies), fallback: { method: recovery.method, policy } }
  }
}
