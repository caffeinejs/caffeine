import { Binding, configurationOf, isConfigurationClass, newBinding } from './binding.js'
import { DeferredCtor } from './deferred_ctor.js'
import { CaffeineIoCError, ErrCircularCondition, ErrInvalidBinding, ErrNoValuesProvider } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import { Identifier, InjectionToken, isValidKey, keyStr } from './key.js'

/**
 * A condition a binding must meet to be registered, built with {@link $cond}.
 *
 * Conditions are decided when the container compiles. A binding carrying several registers only when all of them pass.
 */
export type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'config'; readonly test: (config: never) => boolean }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }

/**
 * One condition, or several that must all pass.
 */
export type Conditions = Condition | readonly Condition[]

/**
 * The condition builders {@link $cond} exposes, parameterised by the configuration a `config` test reads.
 *
 * A callback typed `ConditionHelpers<AppConfig>` types `c.config(cfg => cfg.cache.enabled)` without the call naming
 * the type again, which is what `@Conditional<AppConfig>(c => ...)` does. `$cond` itself leaves `C` at `unknown`.
 */
export interface ConditionHelpers<C = unknown> {
  /**
   * Passes when a binding answers to the key: one registered under it, named after it, or extending it. A condition
   * never sees its own binding.
   */
  present(key: InjectionToken): Condition

  /**
   * Passes when no binding answers to the key, which makes the binding a default that yields to any other.
   */
  missing(key: InjectionToken): Condition

  /**
   * Passes when the test returns `true` for the values bound with `bindConfig()`. Without values bound, the
   * container fails to compile with `ErrNoValuesProvider`.
   *
   * `T` falls back to `C`, which is what types a test whose call names no type argument.
   */
  config<T = C>(test: (config: T) => boolean): Condition

  /**
   * Passes when the environment variable is set, an empty value included, or equals `expected` when given. The
   * variable is read when the container compiles.
   */
  env(name: string, expected?: string): Condition
}

function present(key: InjectionToken): Condition {
  return { kind: 'present', key: checkedKey('present', key) }
}

function missing(key: InjectionToken): Condition {
  return { kind: 'missing', key: checkedKey('missing', key) }
}

function config<T>(test: (config: T) => boolean): Condition {
  if (typeof test !== 'function') {
    throw new ErrInvalidBinding(`Cannot build a config() condition: the test must be a function`)
  }

  return { kind: 'config', test }
}

function env(name: string, expected?: string): Condition {
  if (typeof name !== 'string' || name === '') {
    throw new ErrInvalidBinding(`Cannot build an env() condition: the variable name must be a non-empty string`)
  }
  if (expected !== undefined && typeof expected !== 'string') {
    throw new ErrInvalidBinding(`Cannot build an env() condition for "${name}": the expected value must be a string`)
  }

  return expected === undefined ? { kind: 'env', name } : { kind: 'env', name, expected }
}

// A deferred key never answers to anything the container registers, so a condition on one could never pass.
function checkedKey(kind: string, key: InjectionToken): InjectionToken {
  if (!isValidKey(key) || key instanceof DeferredCtor) {
    throw new ErrInvalidBinding(`Cannot build a ${kind}() condition: "${String(key)}" is not a binding key`)
  }

  return key
}

/**
 * Builds the conditions `@Conditional` and `.conditional()` take.
 *
 * @example
 * ```ts
 * @Conditional([$cond.present(RedisClient), $cond.env('CACHE', 'redis')])
 * @Injectable([RedisClient])
 * class RedisCache extends Cache {}
 *
 * di.bind(Cache, t => t.toClass(InMemoryCache).conditional($cond.missing(Cache)))
 * ```
 */
export const $cond: ConditionHelpers = { present, missing, config, env }

function isCondition(value: unknown): value is Condition {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const condition = value as Record<string, unknown>
  switch (condition.kind) {
    case 'present':
    case 'missing':
      return isValidKey(condition.key) && !(condition.key instanceof DeferredCtor)
    case 'config':
      return typeof condition.test === 'function'
    case 'env':
      return (
        typeof condition.name === 'string' &&
        condition.name !== '' &&
        (condition.expected === undefined || typeof condition.expected === 'string')
      )
    default:
      return false
  }
}

/**
 * Reads what `@Conditional` and `.conditional()` were given: one condition, several, or a callback handed `$cond`
 * that returns either. The callback runs here, once.
 *
 * @param fail - Builds the error for a value that is not a condition.
 */
export function toConditions<C>(
  input: Conditions | ((cond: ConditionHelpers<C>) => Conditions),
  fail: (reason: string, options?: ErrorOptions) => Error,
): Condition[] {
  let given: unknown = input

  if (typeof input === 'function') {
    try {
      given = input($cond)
    } catch (err) {
      if (err instanceof CaffeineIoCError) {
        throw err
      }

      throw fail(
        `the callback threw "${messageOf(err)}"` +
          solutions(
            'A callback is handed $cond, not a context: write c => c.present(X) where a predicate read ' +
              'ctx => ctx.container.has(X)',
          ),
        { cause: err },
      )
    }
  }

  const list: unknown[] = Array.isArray(given) ? [...given] : [given]
  for (const value of list) {
    if (!isCondition(value)) {
      throw fail(`expected a condition built with $cond, got ${typeName(value)}`)
    }
  }

  return list as Condition[]
}

/**
 * A binding waiting for its conditions to be decided, or for the configuration class that provides it.
 */
export interface HeldBinding {
  key: InjectionToken
  binding: Binding
}

/**
 * What deciding the held bindings needs from the container.
 */
export interface ConditionOps {
  /** Whether a binding answers to the key, as `has()` tells. */
  has(key: InjectionToken): boolean
  /** Whether a binding is registered under the key itself. */
  isRegistered(key: InjectionToken): boolean
  /** Whether `bindConfig()` was called. */
  hasValues(): boolean
  values(): unknown
  register(key: InjectionToken, binding: Binding): void
  drop(key: InjectionToken, binding: Binding): void
}

/**
 * The held binding without `key` among the names and the base it answers to, the way `rebind(key)` leaves a registered
 * binding answering to its own key alone. A copy, so the binding declared stays as it was.
 */
export function detachFrom(entry: HeldBinding, key: InjectionToken): HeldBinding {
  const { binding } = entry
  const names = binding.names.filter(name => name !== key)
  const extend = binding.extend === key ? undefined : binding.extend
  if (names.length === binding.names.length && extend === binding.extend) {
    return entry
  }

  return { key: entry.key, binding: newBinding({ ...binding, names, extend }) }
}

/**
 * Decides the held bindings, in three steps.
 *
 * 1. `env` and `config` conditions never depend on another binding, so they are checked first, in the order written.
 *    A binding that fails one is dropped. The `@Provides` of a configuration class still held are checked only once
 *    their class passed.
 * 2. A `present` or `missing` condition waits for every other binding still held that answers to its key, unless a
 *    registered binding answers to it already. A `@Provides` waits for its configuration class.
 * 3. In that order, a binding registers when its configuration class, if any, is registered and every `present` and
 *    `missing` condition passes. It is dropped otherwise.
 *
 * @throws {@link ErrCircularCondition} when bindings wait for each other
 */
export function decideConditions(held: readonly HeldBinding[], ops: ConditionOps): void {
  for (const entry of decisionOrder(checkFirst(held, ops), ops)) {
    const parent = configurationOf(entry.binding)
    if ((parent === undefined || ops.isRegistered(parent)) && passes(entry, ops, isPresence)) {
      ops.register(entry.key, entry.binding)
    } else {
      ops.drop(entry.key, entry.binding)
    }
  }
}

// Step 1. Returns the bindings left to decide, in the order they were held. A @Provides finds its class by key, so it
// waits for the class wherever the class was held.
function checkFirst(held: readonly HeldBinding[], ops: ConditionOps): HeldBinding[] {
  const heldKeys = new Set(held.map(entry => entry.key))
  const heldClassOf = (entry: HeldBinding): InjectionToken | undefined => {
    const parent = configurationOf(entry.binding)
    return parent !== undefined && heldKeys.has(parent) ? parent : undefined
  }

  const passed = new Set<HeldBinding>()
  const passedKeys = new Set<InjectionToken>()
  const check = (entry: HeldBinding): void => {
    if (passes(entry, ops, isStatic)) {
      passed.add(entry)
      passedKeys.add(entry.key)
    }
  }

  for (const entry of held) {
    if (heldClassOf(entry) === undefined) {
      check(entry)
    }
  }
  for (const entry of held) {
    const parent = heldClassOf(entry)
    if (parent !== undefined && passedKeys.has(parent)) {
      check(entry)
    }
  }

  const live: HeldBinding[] = []
  for (const entry of held) {
    if (passed.has(entry)) {
      live.push(entry)
    } else {
      ops.drop(entry.key, entry.binding)
    }
  }

  return live
}

// Step 2, depth first: a binding comes after everything it waits for, and otherwise keeps the order it was held in.
function decisionOrder(live: readonly HeldBinding[], ops: ConditionOps): HeldBinding[] {
  const answering = new Map<InjectionToken | Identifier, number[]>()
  live.forEach((entry, i) => {
    for (const key of answersTo(entry)) {
      const list = answering.get(key)
      if (list === undefined) {
        answering.set(key, [i])
      } else {
        list.push(i)
      }
    }
  })

  const waits = live.map((entry, i) => waitsOf(entry, i, live, answering, ops))

  const order: HeldBinding[] = []
  const done = new Set<number>()
  const path: number[] = []
  const visit = (i: number): void => {
    if (done.has(i)) {
      return
    }

    const at = path.indexOf(i)
    if (at !== -1) {
      const cycle = [...path.slice(at), i]
      throw new ErrCircularCondition(
        cycle.slice(1).map((next, k) => describeWait(live[cycle[k]], live[next], waits[cycle[k]].get(next))),
      )
    }

    path.push(i)
    for (const j of [...waits[i].keys()].sort((a, b) => a - b)) {
      visit(j)
    }
    path.pop()

    done.add(i)
    order.push(live[i])
  }

  for (let i = 0; i < live.length; i++) {
    visit(i)
  }

  return order
}

// What a binding waits for, each with the key it checks that the other answers to; none for its configuration class.
function waitsOf(
  entry: HeldBinding,
  i: number,
  live: readonly HeldBinding[],
  answering: ReadonlyMap<InjectionToken | Identifier, number[]>,
  ops: ConditionOps,
): Map<number, InjectionToken | undefined> {
  const waits = new Map<number, InjectionToken | undefined>()

  const parent = configurationOf(entry.binding)
  if (parent !== undefined) {
    for (const j of answering.get(parent) ?? []) {
      if (live[j].key === parent) {
        waits.set(j, undefined)
      }
    }
  }

  const isClass = isConfigurationClass(entry.binding)
  for (const condition of entry.binding.conditions) {
    // A key a registered binding answers to is settled: deciding only ever adds to what answers to a key.
    if (!isPresence(condition) || ops.has(condition.key)) {
      continue
    }

    for (const j of answering.get(condition.key) ?? []) {
      // A condition never waits for its own binding, nor a class for the @Provides it declares.
      if (j === i || (isClass && configurationOf(live[j].binding) === entry.key) || waits.has(j)) {
        continue
      }

      waits.set(j, condition.key)
    }
  }

  return waits
}

// The keys a binding answers to once registered, as the container maps it under them: its own, its names, and the base
// it extends, which a configuration binding never maps under.
function answersTo({ key, binding }: HeldBinding): Array<InjectionToken | Identifier> {
  const keys: Array<InjectionToken | Identifier> = [key, ...binding.names]
  if (binding.extend !== undefined && !binding.configuration) {
    keys.push(binding.extend)
  }

  return keys
}

function describeWait(waiting: HeldBinding, on: HeldBinding, key: InjectionToken | undefined): string {
  return key === undefined
    ? `"${nameOf(waiting)}" waits for its configuration class "${nameOf(on)}"`
    : `"${nameOf(waiting)}" checks "${keyStr(key)}", which "${nameOf(on)}" answers to`
}

function nameOf({ key, binding }: HeldBinding): string {
  return binding.source === undefined ? keyStr(key) : `${binding.source.ctor.name}.${String(binding.source.method)}()`
}

function isStatic(condition: Condition): boolean {
  return condition.kind === 'env' || condition.kind === 'config'
}

function isPresence(condition: Condition): condition is Extract<Condition, { kind: 'present' | 'missing' }> {
  return condition.kind === 'present' || condition.kind === 'missing'
}

// The conditions `which` selects, in the order they were written, stopping at the first that fails.
function passes(entry: HeldBinding, ops: ConditionOps, which: (condition: Condition) => boolean): boolean {
  for (const condition of entry.binding.conditions) {
    if (which(condition) && !check(condition, entry, ops)) {
      return false
    }
  }

  return true
}

function check(condition: Condition, entry: HeldBinding, ops: ConditionOps): boolean {
  switch (condition.kind) {
    case 'present':
      return ops.has(condition.key)
    case 'missing':
      return !ops.has(condition.key)
    case 'env':
      return checkEnv(condition.name, condition.expected, entry)
    case 'config':
      return checkConfig(condition.test, entry, ops)
  }
}

function checkEnv(name: string, expected: string | undefined, entry: HeldBinding): boolean {
  let value: string | undefined
  try {
    value = hostEnv()[name]
  } catch (err) {
    // Deno without --allow-env refuses the read.
    throw new ErrInvalidBinding(
      `Cannot read the environment variable "${name}" for the conditions of "${keyStr(entry.key)}": ${messageOf(err)}`,
      { cause: err },
    )
  }

  return expected === undefined ? value !== undefined : value === expected
}

function checkConfig(test: (config: never) => boolean, entry: HeldBinding, ops: ConditionOps): boolean {
  if (!ops.hasValues()) {
    throw new ErrNoValuesProvider(`Deciding the config() condition of "${keyStr(entry.key)}"`)
  }

  let result: unknown
  try {
    result = test(ops.values() as never)
  } catch (err) {
    if (err instanceof CaffeineIoCError) {
      throw err
    }

    throw new ErrInvalidBinding(
      `Cannot decide the config() condition of "${keyStr(entry.key)}": its test threw "${messageOf(err)}"`,
      { cause: err },
    )
  }

  // An async test hands back a Promise, which would otherwise read as a pass.
  if (typeof result !== 'boolean') {
    throw new ErrInvalidBinding(
      `Cannot decide the config() condition of "${keyStr(entry.key)}": its test returned ${typeName(result)}, not a boolean`,
    )
  }

  return result
}

// The browser bundle has no process.
function hostEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (value instanceof Promise) {
    return 'a Promise'
  }

  return `a value of type ${typeof value}`
}
