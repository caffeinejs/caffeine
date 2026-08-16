import type { BindingDescriptor, Container } from './container_interface.js'
import type { TypedKey } from './key.js'
import { type AnyClass } from './types.js'
import type { PostResolutionInterceptor } from './post_resolution_interceptor.js'

export const kAspectLabel = Symbol('@caffeinejs/di:aspect')
export const kAspectPointcuts = Symbol('@caffeinejs/di:aspect-pointcuts')

/**
 * Predicate that decides whether a method should be intercepted.
 * Evaluated once per method at weave time — not on every call.
 */
export type PointcutMethodPredicate = (member: string | symbol, descriptor: BindingDescriptor, cls: AnyClass) => boolean

/**
 * Predicate that decides whether a class binding should be intercepted.
 * Evaluated once per class at weave time — not on every instance creation.
 */
export type PointcutClassPredicate = (descriptor: BindingDescriptor, cls: AnyClass) => boolean

/**
 * Describes the execution context for a single intercepted method invocation.
 * Passed to every {@link MethodAspect} hook.
 */
export interface JoinPoint<T = unknown> {
  /**
   * Name of the intercepted method.
   */
  readonly methodName: string | symbol

  /**
   * The target instance on which the method is being invoked.
   */
  readonly target: T

  /**
   * The class constructor for the intercepted instance.
   * Use with `reflect.get(jp.ctor, annotation)` or `reflect.get(jp.ctor, annotation, jp.methodName)`
   * to read annotation values from within a hook.
   */
  readonly ctor: abstract new (...args: any[]) => T

  /**
   * Current argument list.
   * Note that the `before` hook may mutate this array to change args.
   */
  args: unknown[]

  /**
   * Calls the next interceptor in the chain, or the original method if last.
   * Available in `before` and `around` {@link MethodAspect} hooks.
   */
  proceed(...args: unknown[]): unknown
}

/**
 * MethodAspect represents an AOP aspect.
 * Implement one or more hooks to intercept method invocations on the target class (or classes).
 *
 * Aspects are container-managed **singletons**.
 * Use {@link Provider} and $i.provide() to inject dependencies with different scopes.
 *
 * Execution order per invocation:
 * 1. `before`.
 * 2. `around` (controls whether `proceed()` is called) — or automatic proceed if absent.
 * 3. `afterReturn` on success — always receives the resolved value, never a raw Promise.
 * 4. `afterThrow` on error.
 * 5. `after` always. It works as a final catch-all handler.
 */
export interface MethodAspect<T = unknown> {
  before?(joinPoint: JoinPoint<T>): void | Promise<void>
  around?(joinPoint: JoinPoint<T>): unknown | Promise<unknown>
  afterReturn?(joinPoint: JoinPoint<T>, result: unknown): unknown | Promise<unknown>
  afterThrow?(joinPoint: JoinPoint<T>, error: Error): void | Promise<void>
  after?(joinPoint: JoinPoint<T>, result: unknown, error: Error | undefined): void | Promise<void>
}

/**
 * Describes which class(es) and methods an aspect should intercept.
 * Created via `$aop.*` helper functions.
 */
export interface Pointcut {
  target: Function | PointcutClassPredicate
  methods: Set<string | symbol> | PointcutMethodPredicate | null
}

interface WeavingEntry {
  aspectKey: TypedKey<MethodAspect<unknown>>
  methods: Set<string | symbol> | PointcutMethodPredicate | null
  order: number | undefined
}

/**
 * Builds a map from constructor to a PostResolutionInterceptor that weaves aspects onto the
 * resolved instance. Only targeted bindings receive an interceptor — untargeted bindings have
 * zero overhead.
 */
export function buildAOPInterceptors(container: Container): Map<Function, PostResolutionInterceptor> {
  const weavingMap = buildWeavingMap(container)
  const result = new Map<Function, PostResolutionInterceptor>()

  for (const [ctor, entries] of weavingMap) {
    let resolved: ResolvedEntry[] | undefined
    const methodMapCache = new WeakMap<object, Map<string | symbol, MethodAspect[]>>()

    result.set(ctor, (ctx, instance) => {
      resolved ??= entries.map(e => ({
        aspect: ctx.container.get(e.aspectKey),
        methods: e.methods,
      }))

      let methodMap = methodMapCache.get(ctx.binding)
      if (!methodMap) {
        methodMap = buildMethodMap(instance, resolved, ctx, ctx.binding.type as AnyClass)
        methodMapCache.set(ctx.binding, methodMap)
      }

      return weave(instance, methodMap, ctx.binding.type as AnyClass)
    })
  }

  return result
}

export function buildWeavingMap(container: Container): Map<Function, WeavingEntry[]> {
  const map = new Map<Function, WeavingEntry[]>()

  for (const aspect of container.getBindingsByLabel(kAspectLabel)) {
    const { key, binding } = aspect
    const pointcuts = binding.tags.get(kAspectPointcuts) as Pointcut[] | undefined
    if (!pointcuts) {
      continue
    }

    for (const pointcut of pointcuts) {
      const weavingEntry: WeavingEntry = {
        aspectKey: key as TypedKey<MethodAspect<unknown>>,
        methods: pointcut.methods,
        order: binding.order,
      }

      if (isClassPredicate(pointcut.target)) {
        const predicate = pointcut.target

        for (const desc of container.getBindingsBy(bd => {
          const cls = bd.binding.type
          if (!cls) {
            return false
          }

          return predicate(bd, cls as AnyClass)
        })) {
          const ctor = desc.binding.type ?? (typeof desc.key === 'function' ? desc.key : null)
          if (!ctor) {
            continue
          }

          registerEntry(map, ctor, weavingEntry)
        }
      } else {
        registerEntry(map, pointcut.target, weavingEntry)
      }
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  }

  return map
}

function isClassPredicate(f: Function): f is PointcutClassPredicate {
  return f.prototype === undefined
}

function registerEntry(
  map: Map<Function, WeavingEntry[]>,
  ctor: Function,
  entry: WeavingEntry,
): void {
  let list = map.get(ctor)
  if (!list) {
    list = []
    map.set(ctor, list)
  }

  list.push(entry)
}

interface ResolvedEntry {
  aspect: MethodAspect
  methods: Set<string | symbol> | PointcutMethodPredicate | null
}

function weave(instance: unknown, methodMap: Map<string | symbol, MethodAspect[]>, cls: AnyClass): unknown {
  return new Proxy(instance as object, {
    get(target: any, prop: string | symbol, receiver: unknown): unknown {
      const aspects = methodMap.get(prop)
      if (!aspects || aspects.length === 0) {
        return Reflect.get(target, prop, receiver)
      }

      if (typeof target[prop] !== 'function') {
        return Reflect.get(target, prop, receiver)
      }

      return function (...args: unknown[]) {
        return executeChain(target, prop, args, aspects, cls, receiver)
      }
    },
  })
}

function buildMethodMap(
  instance: unknown,
  entries: ResolvedEntry[],
  descriptor: BindingDescriptor,
  cls: AnyClass,
): Map<string | symbol, MethodAspect[]> {
  const map = new Map<string | symbol, MethodAspect[]>()
  const hasPredicates = entries.some(e => typeof e.methods === 'function')
  const hasNulls = entries.some(e => e.methods === null)

  const candidates = new Set<string | symbol>()

  if (hasNulls || hasPredicates) {
    let proto = Object.getPrototypeOf(instance)
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== 'constructor') {
          candidates.add(name)
        }
      }
      proto = Object.getPrototypeOf(proto)
    }
  }

  for (const e of entries) {
    if (e.methods !== null && typeof e.methods !== 'function') {
      for (const m of e.methods) {
        candidates.add(m)
      }
    }
  }

  for (const method of candidates) {
    const aspects: MethodAspect[] = []
    for (const e of entries) {
      if (e.methods === null) {
        aspects.push(e.aspect)
      } else if (typeof e.methods === 'function') {
        if (e.methods(method, descriptor, cls)) {
          aspects.push(e.aspect)
        }
      } else if (e.methods.has(method)) {
        aspects.push(e.aspect)
      }
    }
    if (aspects.length > 0) {
      map.set(method, aspects)
    }
  }

  return map
}

function executeChain(
  target: any,
  methodName: string | symbol,
  args: unknown[],
  aspects: MethodAspect[],
  cls: AnyClass,
  proxy: unknown,
): unknown {
  let nextI = 0

  const jp: JoinPoint<any> = {
    methodName,
    target: proxy as any,
    ctor: cls,
    args,
    proceed(...n: unknown[]) {
      return runStep(nextI, n.length ? n : jp.args)
    },
  }

  function runStep(i: number, a: unknown[]): unknown {
    if (i >= aspects.length) {
      return (target[methodName] as Function).apply(proxy, a)
    }
    nextI = i + 1
    jp.args = a
    return runAspect(aspects[i], jp)
  }

  return runStep(0, args)
}

function handleReturn(aspect: MethodAspect, joinPoint: JoinPoint, result: unknown): unknown {
  if (aspect.afterReturn) {
    let r: unknown
    try {
      r = aspect.afterReturn(joinPoint, result)
    } catch (e) {
      // afterReturn threw — after must still fire before re-throwing
      aspect.after?.(joinPoint, undefined, e as Error)
      throw e
    }
    if (r instanceof Promise) {
      // Use two-arg .then so afterReturn rejection doesn't fall into handleError
      return r.then(
        v => {
          aspect.after?.(joinPoint, v, undefined)
          return v
        },
        e => {
          aspect.after?.(joinPoint, undefined, e as Error)
          throw e
        },
      )
    }
    result = r
  }
  aspect.after?.(joinPoint, result, undefined)
  return result
}

function handleError(aspect: MethodAspect, joinPoint: JoinPoint, err: Error): unknown {
  if (aspect.afterThrow) {
    const maybeThrowAsync = aspect.afterThrow(joinPoint, err)
    if (maybeThrowAsync instanceof Promise) {
      // Call after regardless of whether afterThrow resolved or rejected;
      // if afterThrow rejects, propagate that rejection so the caller sees it.
      return maybeThrowAsync.then(
        () => { aspect.after?.(joinPoint, undefined, err) },
        e => {
          aspect.after?.(joinPoint, undefined, e as Error)
          throw e
        },
      )
    }
    aspect.after?.(joinPoint, undefined, err)
    return undefined
  }
  aspect.after?.(joinPoint, undefined, err)
  throw err
}

function runAspect(aspect: MethodAspect, joinPoint: JoinPoint): unknown {
  let maybeBefore: unknown
  try {
    maybeBefore = aspect.before?.(joinPoint)
  } catch (e) {
    // before threw — after must still fire before re-throwing
    aspect.after?.(joinPoint, undefined, e as Error)
    throw e
  }

  const run = (): unknown => {
    let result: unknown
    try {
      result = aspect.around ? aspect.around(joinPoint) : joinPoint.proceed(...joinPoint.args)
    } catch (e) {
      return handleError(aspect, joinPoint, e as Error)
    }
    if (result instanceof Promise) {
      // Use two-arg .then so hook errors inside handleReturn don't route through handleError
      return result.then(
        v => handleReturn(aspect, joinPoint, v),
        e => handleError(aspect, joinPoint, e as Error),
      )
    }
    return handleReturn(aspect, joinPoint, result)
  }

  if (maybeBefore instanceof Promise) {
    // Chain: catch before-rejection (call after, re-throw), then run method
    // .then(run) is skipped when catch re-throws, so run's own after logic is isolated
    return maybeBefore
      .catch(e => {
        aspect.after?.(joinPoint, undefined, e as Error)
        throw e
      })
      .then(run)
  }

  return run()
}

// Pointcut helper functions
// ---

type MethodSelector = string | symbol | (string | symbol)[] | PointcutMethodPredicate

function normalizeMethods(methods?: MethodSelector): Set<string | symbol> | PointcutMethodPredicate | null {
  if (methods === undefined) {
    return null
  }
  if (typeof methods === 'function') {
    return methods as PointcutMethodPredicate
  }
  return new Set(Array.isArray(methods) ? methods : [methods as string | symbol])
}

function forClass(
  target: new (...args: any[]) => any,
  methods?: MethodSelector,
): Pointcut {
  return { target, methods: normalizeMethods(methods) }
}

function pointcut(
  predicate: PointcutClassPredicate,
  methods?: MethodSelector,
): Pointcut {
  return { target: predicate, methods: normalizeMethods(methods) }
}

function matchMethod(...names: (string | symbol)[]): PointcutMethodPredicate {
  return methodName => names.includes(methodName)
}

function matchClass(...ctors: Function[]): PointcutClassPredicate {
  return (d, _cls) => ctors.some(c => d.binding.type === c || d.key === c)
}

function matchLabel(label: symbol): PointcutClassPredicate {
  return (d, _cls) => d.binding.labels.includes(label)
}

function matchTag(key: symbol, value?: unknown): PointcutClassPredicate {
  return (d, _cls) => d.binding.tags.has(key) && (value === undefined || d.binding.tags.get(key) === value)
}

function matchMethodPattern(regex: RegExp): PointcutMethodPredicate {
  return methodName => typeof methodName === 'string' && regex.test(methodName)
}

function methodHasPrefix(prefix: string): PointcutMethodPredicate {
  return methodName => typeof methodName === 'string' && methodName.startsWith(prefix)
}

function methodHasSuffix(suffix: string): PointcutMethodPredicate {
  return methodName => typeof methodName === 'string' && methodName.endsWith(suffix)
}

export const $aop = {
  forClass,
  pointcut,
  matchMethod,
  matchMethodPattern,
  methodHasPrefix,
  methodHasSuffix,
  matchClass,
  matchLabel,
  matchTag,
}
