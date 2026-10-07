import { Binding, configurationOf, isConfigurationClass } from './binding.js'
import { DeferredCtor } from './deferred_ctor.js'
import { CaffeineIoCError, ErrInvalidBinding, ErrNoValuesProvider } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import { InjectionToken, isValidKey, keyStr } from './key.js'

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
 * Decides the held bindings: each registers when its configuration class, if any, is registered and its conditions
 * pass, and is dropped otherwise. A configuration class goes first and its `@Provides` right after it; everything
 * else follows in the order it was held.
 */
export function decideConditions(held: readonly HeldBinding[], ops: ConditionOps): void {
  const decided = new Set<HeldBinding>()
  const decide = (entry: HeldBinding): void => {
    decided.add(entry)

    const parent = configurationOf(entry.binding)
    if ((parent === undefined || ops.isRegistered(parent)) && passes(entry, ops)) {
      ops.register(entry.key, entry.binding)
    } else {
      ops.drop(entry.key, entry.binding)
    }
  }

  for (const entry of held) {
    if (!isConfigurationClass(entry.binding)) {
      continue
    }

    decide(entry)

    for (const provided of held) {
      if (configurationOf(provided.binding) === entry.key) {
        decide(provided)
      }
    }
  }

  for (const entry of held) {
    if (!decided.has(entry)) {
      decide(entry)
    }
  }
}

// In the order they were declared, stopping at the first that fails.
function passes(entry: HeldBinding, ops: ConditionOps): boolean {
  for (const condition of entry.binding.conditions) {
    if (!check(condition, entry, ops)) {
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
