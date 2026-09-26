import { CaffeineIoCError, ErrInvalidBinding, ErrMissingInjectionKey } from './errors.js'
import { notNil } from './internal/util/assert/index.js'
import { solutions } from './internal/util/errutil/index.js'
import { InjectionToken } from './key.js'

/**
 * A condition a binding must pass to be registered. The container decides it once, when it compiles.
 *
 * A condition is data, built with {@link $cond}. The container reads its `kind` to learn which keys it checks, and
 * decides a binding only after every binding that could answer to those keys has been decided.
 */
export type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'profile'; readonly profiles: readonly string[] }
  | { readonly kind: 'config'; readonly access: ((config: unknown) => unknown) | string; readonly expected: unknown }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }
  | { readonly kind: 'when'; readonly test: () => boolean | Promise<boolean> }

const kinds: ReadonlySet<string> = new Set<Condition['kind']>([
  'present',
  'missing',
  'profile',
  'config',
  'env',
  'when',
])

/**
 * Passes when something answers to the key: a binding registered under it, one named after it, or one extending it.
 */
function present(key: InjectionToken): Condition {
  if (key == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'present': key is null or undefined`)
  }

  return { kind: 'present', key }
}

/**
 * Passes when nothing answers to the key. A binding with this condition on its own key is a default: it yields to any
 * other binding of the key, whichever order they are declared in.
 */
function missing(key: InjectionToken): Condition {
  if (key == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'missing': key is null or undefined`)
  }

  return { kind: 'missing', key }
}

/**
 * Passes when any of the given profiles is active. With no active profile, it never passes.
 */
function profile(profile: string, ...profiles: string[]): Condition {
  notNil(profile, `Cannot call 'profile': parameter profile is required`)

  return { kind: 'profile', profiles: [profile, ...profiles] }
}

/**
 * Passes when the value read through the config provider is `true`, or equals `expected` when one is given.
 *
 * `access` is what `$i.config` takes: a selector, or a dot-separated path. The container reads the provider once,
 * while it compiles, so a reload afterwards does not decide the binding again.
 */
function config<T = unknown>(access: ((config: T) => boolean) | string): Condition
function config<T = unknown, R = unknown>(access: ((config: T) => R) | string, expected: R): Condition
function config(access: ((config: never) => unknown) | string, expected: unknown = true): Condition {
  if (typeof access !== 'function' && typeof access !== 'string') {
    throw new ErrInvalidBinding(`Cannot call 'config': access must be a selector function or a dot-separated path`)
  }

  return { kind: 'config', access: access as ((config: unknown) => unknown) | string, expected }
}

/**
 * Passes when the environment variable is set to a non-empty value, or equals `expected` when one is given.
 *
 * It reads `process.env` where there is one, so outside Node without it the condition never passes.
 */
function env(name: string, expected?: string): Condition {
  notNil(name, `Cannot call 'env': parameter name is required`)

  return expected === undefined ? { kind: 'env', name } : { kind: 'env', name, expected }
}

/**
 * Passes when `test` returns `true`. It may be async.
 *
 * `test` is handed nothing, the container included: whether a key is bound is asked with {@link present} or
 * {@link missing}, which the container can order, and an arbitrary function it cannot.
 */
function when(test: () => boolean | Promise<boolean>): Condition {
  if (typeof test !== 'function') {
    throw new ErrInvalidBinding(`Cannot call 'when': test must be a function`)
  }

  return { kind: 'when', test }
}

/**
 * The condition helpers {@link $cond} exposes, parameterised by what `config` selects from.
 *
 * `C` names the configuration a selector reads, so a callback typed `ConditionHelpers<AppConfig>` types
 * `c.config(cfg => cfg.cache.enabled)` without the call naming the type again. An explicit type argument still wins.
 */
export interface ConditionHelpers<C = unknown> {
  present: typeof present
  missing: typeof missing
  profile: typeof profile
  env: typeof env
  when: typeof when

  /**
   * Passes when the value read through the config provider is `true`.
   */
  config<T = C>(access: ((config: T) => boolean) | string): Condition

  /**
   * Passes when the value read through the config provider equals `expected`.
   */
  config<T = C, R = unknown>(access: ((config: T) => R) | string, expected: R): Condition
}

/**
 * Builds the conditions `@Conditional` and `.conditional()` take. Both also accept a callback handed these helpers,
 * which is the form that needs no import: `@Conditional(c => c.missing(Cache))`.
 *
 * @example
 * ```ts
 * const onRedis = $cond.config<AppConfig>(c => c.cache.kind, 'redis')
 *
 * container.bind(Cache, t => t.toClass(RedisCache).conditional(onRedis))
 * container.bind(Lock, t => t.toClass(RedisLock).conditional(onRedis))
 * ```
 */
export const $cond: ConditionHelpers = {
  present,
  missing,
  profile,
  config,
  env,
  when,
}

/**
 * Whether `value` is a condition of a kind the container knows.
 */
export function isCondition(value: unknown): value is Condition {
  return typeof value === 'object' && value !== null && kinds.has((value as { kind?: unknown }).kind as string)
}

const hint = solutions(
  `Pass a condition built with $cond, e.g. $cond.missing(key)`,
  `Or a callback handed the same helpers, e.g. c => c.missing(key)`,
  `A predicate of your own is c => c.when(() => ...); it is handed no container`,
)

/**
 * Resolves what `@Conditional` and `.conditional()` were handed — a condition, or a callback handed {@link $cond} — to
 * a condition. Anything else is reported through `invalid`, which receives the reason and builds the error of the
 * caller's own API.
 *
 * A callback that throws something other than a {@link CaffeineIoCError} is reported the same way: the likeliest cause
 * is a predicate written for the old API, reading a container it is no longer handed.
 */
export function conditionOf(input: unknown, invalid: (reason: string) => Error): Condition {
  let value = input

  if (typeof input === 'function') {
    try {
      value = (input as (c: ConditionHelpers) => unknown)($cond)
    } catch (error) {
      if (error instanceof CaffeineIoCError) {
        throw error
      }

      throw invalid(`the callback threw "${error instanceof Error ? error.message : String(error)}"` + hint)
    }
  }

  if (!isCondition(value)) {
    throw invalid(
      (typeof input === 'function' ? 'the callback did not return a condition' : 'the argument is not a condition') +
        hint,
    )
  }

  return value
}
