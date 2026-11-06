import type { BindingDescriptor, Container } from './container_interface.js'
import { ErrInvalidAspect } from './errors.js'
import { errMessage } from './internal/util/errutil/index.js'
import type { TypedKey } from './key.js'
import type { PostResolutionInterceptor } from './post_resolution_interceptor.js'
import { type Annotation, isAnnotated, reflect } from './reflect.js'
import { type AnyClass } from './types.js'

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
 *
 * An advised method runs with the instance itself as `this`, so its private members (`#field`) work. An instance that
 * takes no new property, such as a frozen one, is wrapped in a proxy instead: its methods run with the proxy as
 * `this`, and a private member refuses it.
 *
 * Only methods are advised. Weaving reads no member, so it runs no getter, and a function a getter returns is not
 * advised. A method the class declares is looked up on each call, so a later change to it, such as a spy on the
 * prototype, reaches the call. An own method that is neither writable nor configurable cannot be advised: resolving
 * its instance fails with {@link ErrInvalidAspect}.
 *
 * An instance is woven once, by the first container that resolves it: another container that resolves the same object
 * runs the first container's aspects, not its own.
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
  seq: number
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
  const selectors: { predicate: PointcutClassPredicate; entry: WeavingEntry }[] = []
  let seq = 0

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
        seq: seq++,
      }

      if (isClassPredicate(pointcut.target)) {
        selectors.push({ predicate: pointcut.target, entry: weavingEntry })
      } else {
        registerEntry(map, pointcut.target, weavingEntry)
      }
    }
  }

  if (selectors.length > 0) {
    for (const [key, binding] of container.entries()) {
      const cls = binding.type
      if (!cls) {
        continue
      }

      const descriptor: BindingDescriptor = { key, binding }

      for (let i = 0; i < selectors.length; i++) {
        if (selectors[i].predicate(descriptor, cls as AnyClass)) {
          registerEntry(map, cls, selectors[i].entry)
        }
      }
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.seq - b.seq)
  }

  return map
}

function isClassPredicate(f: Function): f is PointcutClassPredicate {
  return f.prototype === undefined
}

function registerEntry(map: Map<Function, WeavingEntry[]>, ctor: Function, entry: WeavingEntry): void {
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

// Woven in place: each advised method becomes an own property of the instance that runs the chain with the instance
// itself as `this`. A proxy would hand every method the proxy instead, and a native private member (`#field`) refuses
// a receiver that is not the instance its class built. A call through `this` still finds the woven property first.
//
// A member is found by its descriptor, never read, so weaving runs no getter and advises no accessor. A method the
// class declares is read from the prototype on each call, so a later change to it reaches the call. A method the
// instance holds itself, such as one bound in the constructor, keeps its attributes and takes the wrapper as its value.
//
// An instance resolved again, such as a value binding, is woven once. One that takes no new property, such as a frozen
// one, is proxied instead.
const woven = new WeakSet<object>()

interface AdvisedMethod {
  readonly prop: string | symbol
  readonly aspects: MethodAspect[]
  // The function the instance held under `prop`, or `undefined` for a method its class declares.
  readonly own: Function | undefined
}

function weave(instance: unknown, methodMap: Map<string | symbol, MethodAspect[]>, cls: AnyClass): unknown {
  const target = instance as Record<string | symbol, unknown>
  if (woven.has(target)) {
    return instance
  }
  // Every method is checked before any is replaced, so a refusal leaves the instance as it was.
  const advised = advisedMethods(target, methodMap, cls)
  if (!Object.isExtensible(target)) {
    return proxied(target, advised, cls)
  }
  woven.add(target)

  // A plain read: `Reflect.get` with the instance as receiver costs about a fifth of an advised call.
  const proto = Object.getPrototypeOf(target) as Record<string | symbol, Function>
  for (const { prop, aspects, own } of advised) {
    if (own === undefined) {
      Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (this: unknown, ...args: unknown[]) {
          return executeChain(target, proto[prop], prop, args, aspects, cls)
        },
      })
    } else {
      Object.defineProperty(target, prop, {
        value: function (this: unknown, ...args: unknown[]) {
          return executeChain(target, own, prop, args, aspects, cls)
        },
      })
    }
  }
  return instance
}

// The members of the method map that are methods of `instance`: data properties holding a function, found by their
// nearest descriptor without reading them.
function advisedMethods(
  instance: object,
  methodMap: Map<string | symbol, MethodAspect[]>,
  cls: AnyClass | undefined,
): AdvisedMethod[] {
  const advised: AdvisedMethod[] = []
  for (const [prop, aspects] of methodMap) {
    const own = Object.getOwnPropertyDescriptor(instance, prop)
    if (own !== undefined) {
      if (typeof own.value !== 'function') {
        continue
      }
      if (!own.writable && !own.configurable) {
        throw lockedMethod(cls, instance, prop)
      }
      advised.push({ prop, aspects, own: own.value as Function })
    } else if (typeof declared(Object.getPrototypeOf(instance) as object | null, prop)?.value === 'function') {
      advised.push({ prop, aspects, own: undefined })
    }
  }
  return advised
}

// The nearest declaration of `prop` up a prototype chain.
function declared(proto: object | null, prop: string | symbol): PropertyDescriptor | undefined {
  for (let p = proto; p !== null; p = Object.getPrototypeOf(p) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(p, prop)
    if (descriptor !== undefined) {
      return descriptor
    }
  }
  return undefined
}

// A property that can be neither replaced nor proxied with another value: a proxy breaks an invariant reading it.
function lockedMethod(cls: AnyClass | undefined, instance: object, prop: string | symbol): ErrInvalidAspect {
  const name = cls?.name ?? (Object.getPrototypeOf(instance) as { constructor?: Function } | null)?.constructor?.name
  const member = String(prop)
  return new ErrInvalidAspect(
    errMessage(
      `Cannot weave "${name}.${member}": its own "${member}" is neither writable nor configurable, so no advice can replace it`,
    )
      .solutions(
        `Declare "${member}" only as a method of "${name}", without binding or defining it on each instance`,
        `Keep the own "${member}" writable or configurable: do not freeze the instance, or define it with writable: true`,
        `Leave "${member}" out of the pointcut that matches "${name}"`,
      )
      .reference('@caffeinejs/di', ErrInvalidAspect)
      .build(),
  )
}

// Every method gets the proxy as `this`, so a call through `this` is advised too, and a private member is refused.
// The proxy reads a method on each access, and keeps one wrapper per method for as long as the method stays the same.
function proxied(instance: Record<string | symbol, unknown>, advised: AdvisedMethod[], cls: AnyClass): unknown {
  const methods = new Map(advised.map(({ prop, aspects }) => [prop, aspects]))
  const wrappers = new Map<string | symbol, { readonly method: Function; readonly wrapper: Function }>()
  const proxy: Record<string | symbol, unknown> = new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      const aspects = methods.get(prop)
      if (aspects === undefined || typeof value !== 'function') {
        return value
      }

      let entry = wrappers.get(prop)
      if (entry?.method !== value) {
        const method = value
        entry = {
          method,
          wrapper: function (...args: unknown[]) {
            return executeChain(proxy, method, prop, args, aspects, cls)
          },
        }
        wrappers.set(prop, entry)
      }
      return entry.wrapper
    },
  })
  return proxy
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
      for (const name of Reflect.ownKeys(proto)) {
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
  method: Function,
  methodName: string | symbol,
  args: unknown[],
  aspects: MethodAspect[],
  cls: AnyClass,
): unknown {
  // Each aspect gets its own join point, whose proceed resumes at the step after that aspect however often it is
  // called: an aspect that proceeds again, as a retry does, runs every aspect inside it again.
  function runStep(i: number, a: unknown[]): unknown {
    if (i >= aspects.length) {
      return method.apply(target, a)
    }

    const jp: JoinPoint<any> = {
      methodName,
      target,
      ctor: cls,
      args: a,
      proceed(...n: unknown[]) {
        return runStep(i + 1, n.length ? n : jp.args)
      },
    }

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
      void aspect.after?.(joinPoint, undefined, e as Error)
      throw e
    }
    if (r instanceof Promise) {
      // Use two-arg .then so afterReturn rejection doesn't fall into handleError
      return r.then(
        v => {
          void aspect.after?.(joinPoint, v, undefined)
          return v
        },
        e => {
          void aspect.after?.(joinPoint, undefined, e as Error)
          throw e
        },
      )
    }
    result = r
  }
  void aspect.after?.(joinPoint, result, undefined)
  return result
}

function handleError(aspect: MethodAspect, joinPoint: JoinPoint, err: Error): unknown {
  if (aspect.afterThrow) {
    const maybeThrowAsync = aspect.afterThrow(joinPoint, err)
    if (maybeThrowAsync instanceof Promise) {
      // Call after regardless of whether afterThrow resolved or rejected;
      // if afterThrow rejects, propagate that rejection so the caller sees it.
      return maybeThrowAsync.then(
        () => {
          void aspect.after?.(joinPoint, undefined, err)
        },
        e => {
          void aspect.after?.(joinPoint, undefined, e as Error)
          throw e
        },
      )
    }
    void aspect.after?.(joinPoint, undefined, err)
    return undefined
  }
  void aspect.after?.(joinPoint, undefined, err)
  throw err
}

function runAspect(aspect: MethodAspect, joinPoint: JoinPoint): unknown {
  let maybeBefore: unknown
  try {
    maybeBefore = aspect.before?.(joinPoint)
  } catch (e) {
    // before threw — after must still fire before re-throwing
    void aspect.after?.(joinPoint, undefined, e as Error)
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
        void aspect.after?.(joinPoint, undefined, e as Error)
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

function forClass(target: new (...args: any[]) => any, methods?: MethodSelector): Pointcut {
  return { target, methods: normalizeMethods(methods) }
}

function pointcut(predicate: PointcutClassPredicate, methods?: MethodSelector): Pointcut {
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

/**
 * Selects what an annotation covers: every method annotated with it, and every method of a class
 * annotated with it at class level.
 *
 * A method counts when `reflect.effective` finds a value for it, so the annotation's `inherit` rule
 * decides whether a declaration on a base class counts.
 */
function annotatedWith(annotation: symbol | Annotation<unknown, never>): Pointcut {
  return pointcut(
    (_descriptor, cls) => isAnnotated(cls, annotation),
    (member, _descriptor, cls) =>
      reflect.effective(cls, annotation as Annotation<unknown, never>, member) !== undefined,
  )
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
  annotatedWith,
}

export type PointcutBuilders = typeof $aop
