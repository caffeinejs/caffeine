import type { BindingDescriptor } from './container_interface.js'
import type { MethodMeta, Binding } from './binding.js'
import type { PostProcessor } from './post_processor.js'
import type { ResolutionContext } from './resolution_context.js'
import type { Key } from './key.js'
import { keyStr } from './key.js'
import { ErrInvalidAspect } from './errors.js'
import { Scopes } from './scope.js'
import { Tag } from './decorators/tag.js'

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Utility type that extracts only method keys from `T`.
 * Used to provide type-safe method name hints for `@Aspect`.
 */
export type MethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T]

/**
 * Predicate that decides whether a method should be intercepted.
 * Receives the method name and its decorator metadata (undefined when no `@Tag`/`@Label` is present).
 *
 * @example
 * ```ts
 * const kTx = Symbol('tx')
 * // intercept only methods tagged with kTx
 * const onlyTx: MethodPredicate = (_name, meta) => meta?.tags.has(kTx) ?? false
 * ```
 */
export type MethodPredicate = (methodName: string | symbol, meta: MethodMeta | undefined) => boolean

/**
 * Predicate that decides whether a class binding should be intercepted.
 * Used with `@AspectOn` for dynamic class discovery at weave time.
 *
 * @example
 * ```ts
 * // intercept all classes labelled with kService
 * const onlyServices: ClassPredicate = d => d.binding.labels.includes(kService)
 * ```
 */
export type ClassPredicate = (descriptor: BindingDescriptor) => boolean

/**
 * Describes the execution context for a single intercepted method invocation.
 * Passed to every {@link MethodAspect} hook.
 */
export interface JoinPoint<T = unknown> {
  /** Name of the intercepted method. */
  readonly methodName: string | symbol
  /** The target instance on which the method is being invoked. */
  readonly target: T
  /** Method-level decorator metadata (`@Tag`/`@Label` on this specific method). Undefined when none present. */
  readonly meta: MethodMeta | undefined
  /** Class-level decorator metadata (`@Tag`/`@Label` on the target class). Undefined when none present. */
  readonly classMeta: MethodMeta | undefined
  /** Current argument list — the `before` hook may mutate this array to change args. */
  args: unknown[]
  /** Calls the next interceptor in the chain, or the original method if last. Available in `before` and `around`. */
  proceed(...args: unknown[]): unknown
}

/**
 * Interface for an AOP aspect class.
 * Implement one or more hooks to intercept method invocations on the target class.
 *
 * **Aspects are container-managed singletons.** Mutable instance fields are shared across all
 * concurrent invocations — keep hooks stateless and use constructor-injected services for state.
 *
 * Execution order per invocation:
 * 1. `before`
 * 2. `around` (controls whether `proceed()` is called) — or automatic proceed if absent
 * 3. `afterReturn` on success — always receives the resolved value, never a raw Promise
 * 4. `afterThrow` on error
 * 5. `after` always
 */
export interface MethodAspect<T = unknown> {
  before?(joinPoint: JoinPoint<T>): void | Promise<void>
  around?(joinPoint: JoinPoint<T>): unknown | Promise<unknown>
  afterReturn?(joinPoint: JoinPoint<T>, result: unknown): unknown | Promise<unknown>
  afterThrow?(joinPoint: JoinPoint<T>, error: Error): void | Promise<void>
  after?(joinPoint: JoinPoint<T>, result: unknown, error: Error | undefined): void | Promise<void>
}

// ── Internal symbols (exported for aspect.ts and container.ts) ──────────────

/** Label applied to every aspect binding — used to discover aspects at weave time. */
export const kAspectLabel = Symbol('caffeine:aspect')

/** Tag key on an aspect binding — holds the list of target/method registrations. */
export const kAspectPointcuts = Symbol('caffeine:aspect-pointcuts')

// ── Aspect presence flag (gate in container.compile) ─────────────────────────

let _aspectCount = 0

export function incrementAspectCount(): void {
  _aspectCount++
}

export function hasAnyAspects(): boolean {
  return _aspectCount > 0
}

// ── Pointcut ──────────────────────────────────────────────────────────────

/**
 * Describes which class(es) and methods an aspect should intercept.
 * Created via `$aop.forClass` or `$aop.pointcut`.
 */
export interface Pointcut {
  target: Function | ClassPredicate
  methods: Set<string | symbol> | MethodPredicate | null
}

interface WeavingEntry {
  aspectKey: Key
  methods: Set<string | symbol> | MethodPredicate | null
  order: number | undefined
}

// ── AOPPostProcessor ──────────────────────────────────────────────────────────

/**
 * PostProcessor that weaves registered aspects onto resolved instances via ES6 Proxy.
 * Registered by the container during compile() when at least one `@Aspect` is present.
 *
 * @framework
 */
export class AOPPostProcessor implements PostProcessor {
  private weavingMap: Map<Function, WeavingEntry[]> | null = null

  beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
    return instance
  }

  afterInit(ctx: ResolutionContext, instance: unknown): unknown {
    if (this.weavingMap === null) {
      this.weavingMap = buildWeavingMap(ctx)
    }
    if (this.weavingMap.size === 0) {
      return instance
    }

    const proto = Object.getPrototypeOf(instance) as { constructor?: Function } | null
    const ctor = proto?.constructor
    if (!ctor) {
      return instance
    }

    const entries = this.weavingMap.get(ctor)
    if (!entries || entries.length === 0) {
      return instance
    }

    return weave(ctx, instance, entries)
  }
}

// ── Weaving map ───────────────────────────────────────────────────────────────

function isClassPredicate(f: Function): f is ClassPredicate {
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

function buildWeavingMap(ctx: ResolutionContext): Map<Function, WeavingEntry[]> {
  const map = new Map<Function, WeavingEntry[]>()

  for (const { key, binding } of ctx.container.getBindingsByLabel(kAspectLabel)) {
    const entries = binding.tags.get(kAspectPointcuts) as Pointcut[] | undefined
    if (!entries) {
      continue
    }

    for (const entry of entries) {
      const weavingEntry: WeavingEntry = { aspectKey: key, methods: entry.methods, order: binding.order }

      if (isClassPredicate(entry.target as Function)) {
        for (const desc of ctx.container.getBindingsBy(entry.target as ClassPredicate)) {
          const ctor = desc.binding.type ?? (typeof desc.key === 'function' ? desc.key as Function : null)
          if (!ctor) {
            continue
          }
          registerEntry(map, ctor, weavingEntry)
        }
      } else {
        registerEntry(map, entry.target as Function, weavingEntry)
      }
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  }

  return map
}

// ── Proxy weaving ─────────────────────────────────────────────────────────────

interface ResolvedEntry {
  aspect: MethodAspect
  methods: Set<string | symbol> | MethodPredicate | null
}

function weave(ctx: ResolutionContext, instance: unknown, entries: WeavingEntry[]): unknown {
  const resolved: ResolvedEntry[] = entries.map(e => ({
    aspect: ctx.container.get(e.aspectKey as any) as MethodAspect,
    methods: e.methods,
  }))

  const memberMeta = ctx.binding.memberMeta
  const classMeta: MethodMeta | undefined
    = (ctx.binding.labels.length > 0 || ctx.binding.tags.size > 0)
      ? { labels: ctx.binding.labels, tags: ctx.binding.tags }
      : undefined

  const methodMap = buildMethodMap(instance, resolved, memberMeta)

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
        return executeChain(target, prop, args, aspects, memberMeta?.get(prop), classMeta)
      }
    },
  })
}

function buildMethodMap(
  instance: unknown,
  entries: ResolvedEntry[],
  memberMeta?: Map<string | symbol, MethodMeta>,
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
    if (memberMeta) {
      for (const name of memberMeta.keys()) {
        candidates.add(name)
      }
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
        if (e.methods(method, memberMeta?.get(method))) {
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

// ── Chain execution ───────────────────────────────────────────────────────────

function executeChain(
  target: any,
  methodName: string | symbol,
  args: unknown[],
  aspects: MethodAspect[],
  meta: MethodMeta | undefined,
  classMeta: MethodMeta | undefined,
): unknown {
  let nextI = 0

  const jp: JoinPoint<any> = {
    methodName,
    target,
    meta,
    classMeta,
    args,
    proceed(...n: unknown[]) {
      return runStep(nextI, n.length ? n : jp.args)
    },
  }

  function runStep(i: number, a: unknown[]): unknown {
    if (i >= aspects.length) {
      return target[methodName](...a) as unknown
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
      // Call after regardless of whether afterThrow resolved or rejected
      return maybeThrowAsync.then(
        () => { aspect.after?.(joinPoint, undefined, err) },
        () => { aspect.after?.(joinPoint, undefined, err) },
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

// ── $aop helpers ──────────────────────────────────────────────────────────────

type MethodSelector = string | symbol | (string | symbol)[] | MethodPredicate

function normalizeMethods(methods?: MethodSelector): Set<string | symbol> | MethodPredicate | null {
  if (methods === undefined) {
    return null
  }
  if (typeof methods === 'function') {
    return methods as MethodPredicate
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
  predicate: ClassPredicate,
  methods?: MethodSelector,
): Pointcut {
  return { target: predicate, methods: normalizeMethods(methods) }
}

function matchMethod(...names: (string | symbol)[]): MethodPredicate {
  return methodName => names.includes(methodName)
}

function matchClass(...ctors: Function[]): ClassPredicate {
  return d => ctors.some(c => d.binding.type === c || d.key === c)
}

function matchLabel(label: symbol): ClassPredicate {
  return d => d.binding.labels.includes(label)
}

function matchTag(key: symbol, value?: unknown): ClassPredicate {
  return d => d.binding.tags.has(key) && (value === undefined || d.binding.tags.get(key) === value)
}

function withMethodTag(key: symbol, value?: unknown): MethodPredicate {
  return (_name, meta) => meta?.tags.has(key) === true && (value === undefined || meta.tags.get(key) === value)
}

function withMethodLabel(label: symbol): MethodPredicate {
  return (_name, meta) => meta?.labels.includes(label) === true
}

function matchMethodPattern(regex: RegExp): MethodPredicate {
  return methodName => typeof methodName === 'string' && regex.test(methodName)
}

function matchMethodStartsWith(prefix: string): MethodPredicate {
  return methodName => typeof methodName === 'string' && methodName.startsWith(prefix)
}

function matchMethodEndsWith(suffix: string): MethodPredicate {
  return methodName => typeof methodName === 'string' && methodName.endsWith(suffix)
}

/**
 * Returns a method decorator that tags the decorated method with `key` and `metadata`,
 * making it discoverable by `MethodPredicate` helpers and accessible via `JoinPoint.meta` at runtime.
 *
 * @example
 * ```ts
 * const kCache = Symbol('cache')
 * function Cache(opts: { ttl: number }) {
 *   return $aop.createMethodDecorator(kCache, opts)
 * }
 * ```
 */
function createMethodDecorator<T>(key: symbol, metadata: T) {
  return Tag(key, metadata)
}

export const $aop = {
  forClass,
  pointcut,
  matchMethod,
  matchMethodPattern,
  matchMethodStartsWith,
  matchMethodEndsWith,
  matchClass,
  matchLabel,
  matchTag,
  withMethodTag,
  withMethodLabel,
  createMethodDecorator,
}

// ── Compile-time aspect validation ────────────────────────────────────────────

export function checkAspects(bindings: Iterable<[Key, Binding]>): void {
  for (const [key, binding] of bindings) {
    if (!binding.labels.includes(kAspectLabel)) {
      continue
    }
    const pointcuts = binding.tags.get(kAspectPointcuts) as Pointcut[] | undefined
    if (!pointcuts || pointcuts.length === 0) {
      throw new ErrInvalidAspect(
        `Cannot compile aspect "${keyStr(key)}": at least one pointcut is required`,
      )
    }
    const scope = binding.scopeID
    if (scope !== undefined && scope !== Scopes.SINGLETON) {
      throw new ErrInvalidAspect(
        `Cannot compile aspect "${keyStr(key)}": aspects must be singleton scoped`,
      )
    }
  }
}
