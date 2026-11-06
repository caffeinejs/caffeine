import { $aop, type AnyClass, type JoinPoint, type MethodAspect, type Pointcut, reflect } from '@caffeinejs/di'
import { formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { compose, lift, signalIndex, withSignal } from '../compose.js'
import { described, ErrInvalidOption } from '../errors.js'
import { fallback } from '../fallback/fallback.js'
import type { Operation, PolicyLike } from '../policy.js'
import { ANNOTATIONS, Fallback } from './annotations.js'
import { Attempt, type ResilienceContextStorage } from './context.js'
import { kAddFallback, labelOf, type ResilienceKind, type ResilienceRegistry } from './registry.js'
import { checkClassPresets, stagesOf, woven, wovenMembers } from './stages.js'
import type { ResilienceTransport } from './transport.js'

type Member = string | symbol

// The instance of each kind a method names.
type Stage<K extends ResilienceKind> = ReturnType<ResilienceRegistry[K]>
type Stages = { readonly [K in ResilienceKind]: Stage<K> | undefined }

// Outermost first. The bulkhead sits inside the time limiter, so a call that timed out keeps its slot until it ends.
const ORDER: readonly ResilienceKind[] = ['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']

function orderError(reason: string): ErrInvalidOption {
  const kinds = ORDER.map(kind => `"${kind}"`).join(', ')
  return new ErrInvalidOption(
    errMessage(`Cannot order the resilience policies: ${reason}`)
      .solutions(`List each of ${kinds} once, outermost first`)
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

function checkedOrder(order: readonly ResilienceKind[]): readonly ResilienceKind[] {
  if (!Array.isArray(order)) {
    throw orderError(`order must be an array, got ${described(order)}`)
  }

  const seen = new Set<unknown>()
  for (const kind of order as readonly unknown[]) {
    if (kind === 'fallback') {
      throw orderError('order names "fallback", which is always outermost')
    }
    if (!ORDER.includes(kind as ResilienceKind)) {
      const named = typeof kind === 'string' ? `"${kind}"` : described(kind)
      throw orderError(`order names ${named}, which is not a policy kind`)
    }
    if (seen.has(kind)) {
      throw orderError(`order names "${String(kind)}" twice`)
    }
    seen.add(kind)
  }

  const missing = ORDER.find(kind => !seen.has(kind))
  if (missing !== undefined) {
    throw orderError(`order leaves out "${missing}"`)
  }
  return [...order]
}

/** Where the resilience aspect sits among aspects: outside every aspect with a positive order or none. */
export const RESILIENCE_ASPECT_ORDER = 0

/**
 * Every method that carries a resilience annotation, and every method a class-level one reaches, in every class the
 * container builds.
 */
export const resiliencePointcut: Pointcut = $aop.pointcut(
  (_descriptor, cls) => wovenMembers(cls).size > 0,
  (member, _descriptor, cls) => woven(cls, member),
)

// What one method runs through, built once, the first time it is needed. The join point is the input.
type Plan = Operation<unknown, JoinPoint>

// The plans of one class's methods and, for an entrypoint, how the transport that claims it tells client errors apart.
interface Plans {
  readonly methods: Map<Member, Plan>
  isClientError: ((error: unknown) => boolean) | undefined
}

/**
 * Runs each annotated method through its policies, in one order whatever the order of the decorators: the fallback
 * outermost, then, unless `order` says otherwise, retry, circuit breaker, rate limiter, time limiter and bulkhead.
 *
 * The first argument that is an `AbortSignal` is taken as the caller's signal. Where a time limiter gives the attempt
 * a signal of its own, the method receives that one in its place: it aborts with the caller's too, and stays linked
 * to it after the method returns, so a body it streams still learns that the caller left.
 */
export class ResilienceAspect implements MethodAspect {
  readonly #registry: ResilienceRegistry
  readonly #order: readonly ResilienceKind[]
  readonly #storage: ResilienceContextStorage | undefined
  // How many attempts each call has started, kept only with a storage.
  readonly #attempts = new WeakMap<JoinPoint, number>()
  readonly #plans = new WeakMap<AnyClass, Plans>()

  /**
   * `order` lists the policy kinds outermost first, each once. With `storage`, each attempt runs inside
   * `storage.run(...)`, where a `ResilienceContext` reads it.
   *
   * @throws {@link ErrInvalidOption} when `order` leaves a kind out, names one twice or names anything else.
   */
  constructor(
    registry: ResilienceRegistry,
    order: readonly ResilienceKind[] = ORDER,
    storage?: ResilienceContextStorage,
  ) {
    this.#registry = registry
    this.#order = checkedOrder(order)
    this.#storage = storage
  }

  /**
   * Builds the plan of every annotated method of `cls`. With the `transport` that claims `cls` as an entrypoint, every
   * call of its methods tells the policies which errors are the client's own answer, with
   * {@link ResilienceTransport.isClientError}.
   *
   * @throws {@link ErrInvalidOption} when a method names a preset nothing defines or a policy its preset lacks, a
   * `@Fallback` names a method `cls` lacks, an annotation is on a static or a private method, or a bulkhead or rate
   * limiter inside a method's time limiter may wait as long as its limit.
   */
  prepare(cls: AnyClass, transport?: ResilienceTransport): void {
    const plans = this.#plansOf(cls)
    if (transport !== undefined) {
      plans.isClientError = error => transport.isClientError(error)
    }

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

    checkClassPresets(cls, this.#registry)
    for (const member of wovenMembers(cls)) {
      this.#plan(cls, plans, member)
    }
  }

  around(jp: JoinPoint): unknown {
    const cls = jp.ctor as AnyClass
    const plans = this.#plansOf(cls)
    let plan: Plan
    try {
      plan = this.#plan(cls, plans, jp.methodName)
    } catch (error) {
      // The method returns a promise, so a plan that cannot be built rejects it rather than throwing.
      return Promise.reject(error)
    }

    const i = signalIndex(jp.args)
    // Never `args[-1]`: reading a negative index leaves the fast element path and slows every call. A method given no
    // signal runs under the attempt it is called from, so a deadline set above still reaches the code below it.
    const signal = (i === -1 ? this.#enclosing() : jp.args[i]) as AbortSignal | undefined
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(signal.reason)
    }
    return plan({ signal, isClientError: plans.isClientError }, jp)
  }

  // The signal of the attempt the current code runs in, when the aspect stores attempts.
  #enclosing(): AbortSignal | undefined {
    const store = this.#storage?.getStore()
    return store instanceof Attempt ? store.signal : undefined
  }

  #plansOf(cls: AnyClass): Plans {
    let plans = this.#plans.get(cls)
    if (plans === undefined) {
      plans = { methods: new Map(), isClientError: undefined }
      this.#plans.set(cls, plans)
    }
    return plans
  }

  #plan(cls: AnyClass, plans: Plans, member: Member): Plan {
    let plan = plans.methods.get(member)
    if (plan === undefined) {
      plan = this.#build(cls, member)
      plans.methods.set(member, plan)
    }
    return plan
  }

  #build(cls: AnyClass, member: Member): Plan {
    const where = `${cls.name}.${String(member)}`
    const sources = stagesOf(cls, member, this.#registry).stages
    const stage = <K extends ResilienceKind>(kind: K): Stage<K> | undefined => {
      const source = sources[kind]
      return source === undefined ? undefined : (this.#registry[kind](source.preset) as Stage<K>)
    }

    const stages: Stages = {
      retry: stage('retry'),
      circuitBreaker: stage('circuitBreaker'),
      rateLimiter: stage('rateLimiter'),
      timeLimiter: stage('timeLimiter'),
      bulkhead: stage('bulkhead'),
    }
    this.#checkWaits(where, stages)
    const policies = this.#order
      .map((kind): PolicyLike | undefined => stages[kind])
      .filter((policy): policy is PolicyLike => policy !== undefined)

    const storage = this.#storage
    const method =
      storage === undefined
        ? lift<unknown, JoinPoint>(
            (ctx, jp) => jp.proceed(...withSignal(jp.args as unknown[], ctx.signal, undefined)) as Promise<unknown>,
          )
        : lift<unknown, JoinPoint>((ctx, jp) => {
            const attempt = (this.#attempts.get(jp) ?? 0) + 1
            this.#attempts.set(jp, attempt)
            return storage.run(
              new Attempt(ctx.signal, attempt),
              () => jp.proceed(...withSignal(jp.args as unknown[], ctx.signal, undefined)) as Promise<unknown>,
            )
          })
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

  // A wait inside the time limiter counts against its limit. One that can last as long as the limit lets a waiting
  // call time out, which a circuit breaker counts as a failure, where it would have been refused, which it ignores.
  #checkWaits(where: string, stages: Stages): void {
    const limiter = stages.timeLimiter
    if (limiter === undefined) {
      return
    }

    for (const kind of ['bulkhead', 'rateLimiter'] as const) {
      const waiting = stages[kind]
      if (
        waiting === undefined ||
        this.#order.indexOf(kind) < this.#order.indexOf('timeLimiter') ||
        waiting.maxWaitDuration < limiter.timeoutDuration
      ) {
        continue
      }

      const outside = this.#order.filter(other => other !== kind)
      outside.splice(outside.indexOf('timeLimiter'), 0, kind)
      const order = outside.map(other => `'${other}'`).join(', ')
      throw new ErrInvalidOption(
        errMessage(
          `Cannot weave "${where}": ${labelOf(kind)} "${waiting.name}" may wait ${formatDuration(waiting.maxWaitDuration)}, ` +
            `not less than the ${formatDuration(limiter.timeoutDuration)} limit of time limiter "${limiter.name}" ` +
            'around it, so a waiting call would time out instead of being refused',
        )
          .solutions(
            `Set maxWaitDuration of ${labelOf(kind)} "${waiting.name}" below ${formatDuration(limiter.timeoutDuration)}`,
            `Order the ${labelOf(kind)} outside the time limiter with r.order([${order}])`,
          )
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
  }
}
