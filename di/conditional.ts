import { CaffeineIoCError, ErrInvalidBinding, ErrMissingInjectionKey } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import { InjectionToken } from './key.js'

/**
 * A condition a binding must pass to be registered, built with {@link $cond}.
 *
 * The container decides every condition once, when it compiles. Its `kind` says what it reads: `present` and
 * `missing` the bindings answering to a key, `config` the values provider, `env` the environment, and `when` only
 * what its test closes over.
 */
export type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'config'; readonly access: string | ((config: never) => unknown); readonly expected: unknown }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }
  | { readonly kind: 'when'; readonly test: () => boolean | Promise<boolean> }

/**
 * Passes when a binding answers to `key`: one registered under it, one named after it, or one extending it.
 *
 * The binding being decided never counts, so a binding cannot satisfy its own condition.
 */
function present(key: InjectionToken): Condition {
  if (key == null) {
    throw new ErrMissingInjectionKey(`Cannot build a present condition: key is null or undefined`)
  }

  return { kind: 'present', key }
}

/**
 * Passes when no binding answers to `key`.
 *
 * The binding being decided never counts, so a binding with this condition on its own key is a default: it
 * registers only when nothing else answers to the key.
 */
function missing(key: InjectionToken): Condition {
  if (key == null) {
    throw new ErrMissingInjectionKey(`Cannot build a missing condition: key is null or undefined`)
  }

  return { kind: 'missing', key }
}

/**
 * Passes when the value read through the values provider is `true`, or equals `expected` when one is given.
 *
 * `access` is what `$i.value` takes: a selector, or a dot-separated path. The provider is read when the container
 * compiles, before anything resolves, so it must be bound with `toValue()`, or with `toFactory()` and no injections.
 * `init()` throws {@link ErrNoValuesProvider} when none is bound, and {@link ErrInvalidBinding} when it is bound
 * in a form that cannot be read yet.
 *
 * @example
 * ```ts
 * c.config('cache.enabled')
 * c.config('cache.kind', 'redis')
 * c.config<AppConfig>(cfg => cfg.cache.kind, 'redis')
 * ```
 */
function config<T = unknown>(access: ((config: T) => boolean) | string): Condition
function config<T = unknown, R = unknown>(access: ((config: T) => R) | string, expected: R): Condition
function config(access: ((config: never) => unknown) | string, ...rest: [expected?: unknown]): Condition {
  if (typeof access !== 'string' && typeof access !== 'function') {
    throw new ErrInvalidBinding(`Cannot build a config condition: access must be a selector or a dot-separated path`)
  }

  return { kind: 'config', access, expected: rest.length === 0 ? true : rest[0] }
}

/**
 * Passes when the environment variable is set to a non-empty value, or equals `expected` when one is given.
 *
 * The variable is read when the container compiles. Where the runtime has no `process.env`, it is unset.
 */
function env(name: string, expected?: string): Condition {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ErrInvalidBinding(`Cannot build an env condition: name must be a non-empty string`)
  }

  return expected === undefined ? { kind: 'env', name } : { kind: 'env', name, expected }
}

/**
 * Passes when `test` returns `true`. It may be async.
 *
 * `test` is handed nothing: whether a key is bound is asked with `present` or `missing`.
 */
function when(test: () => boolean | Promise<boolean>): Condition {
  if (typeof test !== 'function') {
    throw new ErrInvalidBinding(`Cannot build a when condition: test must be a function`)
  }

  return { kind: 'when', test }
}

/**
 * The condition builders of {@link $cond}, which a `@Conditional` or `.conditional()` callback is also handed.
 */
export interface ConditionHelpers {
  present: typeof present
  missing: typeof missing
  config: typeof config
  env: typeof env
  when: typeof when
}

/**
 * Builds the conditions `@Conditional` and `.conditional()` take. Both also accept a callback handed these builders,
 * the form that needs no import.
 *
 * @example
 * ```ts
 * const onRedis = $cond.config<AppConfig>(cfg => cfg.cache.kind, 'redis')
 *
 * container.bind(Cache, t => t.toClass(RedisCache).conditional(onRedis))
 * container.bind(Lock, t => t.toClass(RedisLock).conditional(onRedis))
 * ```
 */
export const $cond: ConditionHelpers = {
  present,
  missing,
  config,
  env,
  when,
}

const kinds: ReadonlySet<unknown> = new Set<Condition['kind']>(['present', 'missing', 'config', 'env', 'when'])

// Whether `value` is a condition of a kind the container decides.
export function isCondition(value: unknown): value is Condition {
  return typeof value === 'object' && value !== null && kinds.has((value as { kind?: unknown }).kind)
}

const hint = solutions(
  `Build the condition with $cond, e.g. $cond.missing(Cache)`,
  `Or pass a callback handed the same builders, e.g. c => c.missing(Cache)`,
  `Wrap a predicate of your own in c.when(() => ...): it is handed no container`,
)

// Resolves what @Conditional or .conditional() was handed into a condition, calling a callback once, with $cond.
// Anything else is reported through `invalid`, which builds the caller's own error. A callback that throws anything
// but a container error is most likely a predicate written for the old API, reading a container it is not handed.
export function conditionOf(input: unknown, invalid: (reason: string) => Error): Condition {
  if (typeof input !== 'function') {
    if (!isCondition(input)) {
      throw invalid(`the argument is not a condition` + hint)
    }

    return input
  }

  let value: unknown
  try {
    value = (input as (c: ConditionHelpers) => unknown)($cond)
  } catch (error) {
    if (error instanceof CaffeineIoCError) {
      throw error
    }

    throw invalid(`the callback threw "${error instanceof Error ? error.message : String(error)}"` + hint)
  }

  if (!isCondition(value)) {
    throw invalid(`the callback did not return a condition` + hint)
  }

  return value
}
