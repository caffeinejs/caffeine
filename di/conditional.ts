import { Binding, configurationOf, isConfigurationClass, newBinding } from './binding.js'
import { DeferredCtor } from './deferred_ctor.js'
import { CaffeineIoCError, ErrCircularCondition, ErrInvalidBinding, ErrNoValuesProvider } from './errors.js'
import { parseBool } from './internal/util/bool/index.js'
import { errMessage } from './internal/util/errutil/index.js'
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
   * Passes when the environment variable reads as true: `1`, `t`, `true`, `on` or `yes`, in any letter case. `0`,
   * `f`, `false`, `off`, `no` or an unset variable fail it, and any other value fails the container's compilation with
   * `ErrInvalidBinding`. With `expected`, passes when the value equals it exactly.
   *
   * The variable is read when the container compiles.
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
    throw new ErrInvalidBinding(
      errMessage(`Cannot build a config() condition: the test must be a function`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
  }

  return { kind: 'config', test }
}

function env(name: string, expected?: string): Condition {
  if (typeof name !== 'string' || name === '') {
    throw new ErrInvalidBinding(
      errMessage(`Cannot build an env() condition: the variable name must be a non-empty string`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
  }
  if (expected !== undefined && typeof expected !== 'string') {
    throw new ErrInvalidBinding(
      errMessage(`Cannot build an env() condition for "${name}": the expected value must be a string`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
  }

  return expected === undefined ? { kind: 'env', name } : { kind: 'env', name, expected }
}

function checkedKey(kind: string, key: InjectionToken): InjectionToken {
  // A deferred key never answers to anything the container registers, so a condition on one could never pass.
  if (key instanceof DeferredCtor) {
    throw new ErrInvalidBinding(
      errMessage(`Cannot build a ${kind}() condition: a deferred key never answers to a binding`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
  }
  if (!isValidKey(key)) {
    throw new ErrInvalidBinding(
      errMessage(`Cannot build a ${kind}() condition: expected a binding key, got ${typeName(key)}`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
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

      // The caller's `fail` names the class and adds the reference.
      throw fail(
        errMessage(`the callback threw "${messageOf(err)}"`)
          .solutions(
            'A callback is handed $cond, not a context: write c => c.present(X) where a predicate read ' +
              'ctx => ctx.container.has(X)',
          )
          .build(),
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
 * 1. What depends on no binding still held is checked first: a `present` or `missing` condition on a key a registered
 *    binding answers to already, then the `env` and `config` conditions, in the order written. A binding that fails
 *    one is dropped. A `@Provides` is checked once the binding it follows passed, and is dropped with it. While that
 *    binding still waits on a `present` or `missing` condition, the `env` and `config` of the `@Provides` wait too.
 * 2. Any other `present` or `missing` condition waits for every other binding still held that answers to its key,
 *    except the `@Provides` that follow its own binding. A `@Provides` waits for the binding it follows.
 * 3. In that order, a binding registers when every `present` and `missing` condition passes and, for a `@Provides`,
 *    the binding it follows registered and any `env` and `config` it waited with pass. It is dropped otherwise.
 *
 * A `@Provides` follows its configuration class while that is held, or the replacement `rebind()` holds in its place.
 * One whose class is registered follows nothing, and one whose class key nothing holds is dropped.
 *
 * @throws {@link ErrCircularCondition} when bindings wait for each other
 */
export function decideConditions(held: readonly HeldBinding[], ops: ConditionOps): void {
  const pending = checkFirst(held, ops)
  const registered = new Set<HeldBinding>()

  for (const entry of decisionOrder(pending, ops)) {
    if (passesLast(entry, pending, registered, ops)) {
      ops.register(entry.key, entry.binding)
      registered.add(entry)
    } else {
      ops.drop(entry.key, entry.binding)
    }
  }
}

// What step 1 leaves to decide: the bindings left, in the order they were held, the binding each @Provides follows, and
// the @Provides whose env and config wait for step 3.
interface Pending {
  live: HeldBinding[]
  follows: Map<HeldBinding, HeldBinding>
  deferred: Set<HeldBinding>
}

// Step 1.
function checkFirst(held: readonly HeldBinding[], ops: ConditionOps): Pending {
  const follows = followedBy(held, ops)

  const live = new Set<HeldBinding>()
  for (const entry of held) {
    if (!follows.has(entry) && classRegistered(entry, ops) && passesFirst(entry, ops)) {
      live.add(entry)
    }
  }
  const deferred = checkProvides(follows, live, ops)

  for (const entry of held) {
    if (!live.has(entry)) {
      ops.drop(entry.key, entry.binding)
    }
  }

  return { live: held.filter(entry => live.has(entry)), follows, deferred }
}

// Adds to `live` the @Provides step 1 leaves, and returns those whose env and config wait for step 3. A @Provides goes
// with the binding it follows: none of its conditions is checked once that one failed, and its env and config only once
// that one is sure to register.
function checkProvides(
  follows: ReadonlyMap<HeldBinding, HeldBinding>,
  live: Set<HeldBinding>,
  ops: ConditionOps,
): Set<HeldBinding> {
  const deferred = new Set<HeldBinding>()
  for (const [entry, followed] of follows) {
    if (!live.has(followed)) {
      continue
    }

    const sure = isSure(followed, ops)
    if (sure ? passesFirst(entry, ops) : passes(entry, ops, settledBy(ops))) {
      live.add(entry)
      if (!sure) {
        deferred.add(entry)
      }
    }
  }

  return deferred
}

// A binding left after step 1 registers for sure when none of its present() and missing() conditions waits.
function isSure(entry: HeldBinding, ops: ConditionOps): boolean {
  return entry.binding.conditions.every(condition => !isPresence(condition) || ops.has(condition.key))
}

// The held binding each @Provides follows: its configuration class while that is held, or else, while nothing is
// registered under the class key, the binding held there, which only a rebind() replacement can be.
function followedBy(held: readonly HeldBinding[], ops: ConditionOps): Map<HeldBinding, HeldBinding> {
  const under = new Map<InjectionToken, HeldBinding>()
  for (const entry of held) {
    if (isConfigurationClass(entry.binding) || !under.has(entry.key)) {
      under.set(entry.key, entry)
    }
  }

  const follows = new Map<HeldBinding, HeldBinding>()
  for (const entry of held) {
    const key = configurationOf(entry.binding)
    const followed = key === undefined ? undefined : under.get(key)
    if (followed !== undefined && (isConfigurationClass(followed.binding) || !ops.isRegistered(followed.key))) {
      follows.set(entry, followed)
    }
  }

  return follows
}

// A @Provides that follows no held binding needs its class registered already: nothing registers it this round.
function classRegistered(entry: HeldBinding, ops: ConditionOps): boolean {
  const key = configurationOf(entry.binding)

  return key === undefined || ops.isRegistered(key)
}

// The bindings step 2 orders, and what it looks up about them.
interface Graph {
  live: readonly HeldBinding[]
  follows: ReadonlyMap<HeldBinding, HeldBinding>
  index: ReadonlyMap<HeldBinding, number>
  answering: ReadonlyMap<InjectionToken | Identifier, number[]>
}

// Step 2, depth first: a binding comes after everything it waits for, and otherwise keeps the order it was held in.
function decisionOrder({ live, follows }: Pending, ops: ConditionOps): HeldBinding[] {
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

  const graph: Graph = { live, follows, index: new Map(live.map((entry, i) => [entry, i])), answering }
  const waits = live.map((_, i) => waitsOf(i, graph, ops))

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

// What a binding waits for, each with the key it checks that the other answers to; none for the binding it follows.
function waitsOf(
  i: number,
  { live, follows, index, answering }: Graph,
  ops: ConditionOps,
): Map<number, InjectionToken | undefined> {
  const entry = live[i]
  const waits = new Map<number, InjectionToken | undefined>()

  const followed = follows.get(entry)
  if (followed !== undefined) {
    waits.set(index.get(followed)!, undefined)
  }

  for (const condition of entry.binding.conditions) {
    // A settled key was decided in step 1.
    if (!isPresence(condition) || ops.has(condition.key)) {
      continue
    }

    for (const j of answering.get(condition.key) ?? []) {
      // A condition never waits for its own binding, nor for the @Provides that follow it.
      if (j === i || follows.get(live[j]) === entry || waits.has(j)) {
        continue
      }

      waits.set(j, condition.key)
    }
  }

  return waits
}

// Step 3 for one binding, once everything it waits for is decided. A @Provides that waited checks its env and config
// first, as step 1 would have.
function passesLast(
  entry: HeldBinding,
  { follows, deferred }: Pending,
  registered: ReadonlySet<HeldBinding>,
  ops: ConditionOps,
): boolean {
  const followed = follows.get(entry)
  if (followed !== undefined && !registered.has(followed)) {
    return false
  }
  if (deferred.has(entry) && !passes(entry, ops, isStatic)) {
    return false
  }

  return passes(entry, ops, isPresence)
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

// Step 1 for one binding: what is settled is checked before anything with an effect runs.
function passesFirst(entry: HeldBinding, ops: ConditionOps): boolean {
  return passes(entry, ops, settledBy(ops)) && passes(entry, ops, isStatic)
}

// A key a registered binding answers to is settled: deciding only ever adds to what answers to a key, so its present()
// or missing() is known already.
function settledBy(ops: ConditionOps): (condition: Condition) => boolean {
  return condition => isPresence(condition) && ops.has(condition.key)
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
      errMessage(
        `Cannot read the environment variable "${name}" for the conditions of "${keyStr(entry.key)}": ${messageOf(err)}`,
      )
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
      { cause: err },
    )
  }

  if (expected !== undefined) {
    return value === expected
  }
  if (value === undefined) {
    return false
  }

  const flag = parseBool(value)
  if (flag === undefined) {
    // The value stays out of the message: a variable once checked only for being set may hold a credential.
    throw new ErrInvalidBinding(
      errMessage(`Cannot decide the env() condition of "${keyStr(entry.key)}": the variable "${name}" is not a boolean`)
        .solutions(
          `Set "${name}" to 1, t, true, on or yes to register the binding, or to 0, f, false, off or no to skip it, in any letter case`,
          `Match another value with env("${name}", expected)`,
        )
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
    )
  }

  return flag
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
      errMessage(`Cannot decide the config() condition of "${keyStr(entry.key)}": its test threw "${messageOf(err)}"`)
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
      { cause: err },
    )
  }

  // An async test hands back a Promise, which would otherwise read as a pass.
  if (typeof result !== 'boolean') {
    throw new ErrInvalidBinding(
      errMessage(
        `Cannot decide the config() condition of "${keyStr(entry.key)}": its test returned ${typeName(result)}, not a boolean`,
      )
        .reference('@caffeinejs/di', ErrInvalidBinding)
        .build(),
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
  if (value === '') {
    return 'an empty string'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (value instanceof Promise) {
    return 'a Promise'
  }

  return `a value of type ${typeof value}`
}
