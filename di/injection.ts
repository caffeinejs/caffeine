import { DeferredCtor } from './deferred_ctor.js'
import { ErrMissingInjectionKey } from './errors.js'
import { BuiltInResolvers } from './injection_resolver.js'
import { solutions } from './internal/util/errutil/index.js'
import { InjectionToken, isValidKey } from './key.js'
import type { Provider } from './provider.js'

declare const kInjectionResult: unique symbol

/**
 * Marks a value as an injection descriptor rather than a plain object.
 *
 * Stamped by {@link encode}, which every helper in this module returns through, and read by both the type level
 * ({@link InjectedField}) and the runtime ({@link isDescriptor}) — so the two cannot disagree about what a value in
 * an object spec is. Non-enumerable, so it never shows up as data.
 */
export const kInjectionDescriptor: unique symbol = Symbol('@caffeinejs/di:injection-descriptor')

/**
 * InjectionDescriptor describes an injection for a component dependency.
 *
 * `T` is the **resolved** value (what the consumer receives), not necessarily the
 * lookup key. Helpers such as `$i.optional` and `$i.allOf` encode that
 * result in `T` (`U | undefined`, `U[]`, {@link Provider}, and so on).
 */
export type InjectionDescriptor<T = unknown> = {
  /**
   * The key of the desired dependency.
   * The lookup token is independent of {@link T} when a helper wraps the result
   * (optional, allOf, provide, …).
   */
  key?: InjectionToken<any>

  /**
   * Whether to inject multiple bindings associated with the same key.
   * Normally this is used for named bindings or abstract classes.
   *
   * @remarks
   *
   * Marking a injection as multiple does not necessarily mean that multiple bindings will be injected.
   * A resolver must read this flag and implement the logic to inject multiple bindings.
   *
   * @defaultValue false
   */
  multiple?: boolean

  /**
   * Whether the dependency is optional.
   */
  optional?: boolean

  /**
   * The resolver of the dependency.
   * This allows using custom {@link InjectionResolver} implementations.
   * For custom resolvers, make sure to register it using {@link bindResolver}.
   */
  resolver?: symbol

  /**
   * The arguments to pass to the resolver.
   */
  args?: unknown

  readonly [kInjectionResult]?: T
}

/**
 * ObjectInjections describes how an object should be injected.
 */
export interface ObjectInjections {
  children: Record<string | symbol, ObjectInjection>
}

/**
 * ObjectInjection describes an injection for a property of an object.
 */
export type ObjectInjection = InjectionDescriptor | ObjectInjections

/**
 * Injection describes a dependency injection.
 * Can be expressed by simple providing the key of the dependency, or for more complex cases, by providing an {@link InjectionDescriptor}.
 * Prefer to use the injection functions available in this module to create injections.
 *
 * @example
 * ```ts
 * @Injectable([UserRepository, optional(Notifier), allOf(Validator)])
 * class UserService {
 *   constructor(readonly repository: UserRepository, readonly notifier: Notifier, readonly validators: Validator[]) {}
 * }
 * ```
 */
export type Injection<T = unknown> = InjectionToken<T> | InjectionDescriptor<T>

/**
 * Helper return type: an {@link InjectionDescriptor} branded with its resolved value `T`.
 */
type InjectionResult<T> = InjectionDescriptor<T> & {
  readonly [kInjectionResult]: T
  readonly [kInjectionDescriptor]: true
}

/**
 * One injection per constructor (or factory) parameter, in order.
 *
 * Tokens and `$i` helpers only — a hand-written `{ key }` descriptor is not in this list at the type level.
 * `$i.optional(X)` matches `X | undefined`, not a required `X`.
 */
export type InjectionsFor<A extends readonly unknown[]> = {
  [K in keyof A]: InjectionToken<A[K]> | InjectionResult<A[K]>
}

/**
 * The value produced when `I` is resolved: the instance of a token, or the
 * encoded result type of an {@link InjectionDescriptor}.
 */
export type ResolveInjection<I> =
  I extends InjectionToken<infer T>
    ? T
    : I extends { readonly [kInjectionResult]: infer T }
      ? T
      : I extends InjectionDescriptor<infer T>
        ? T
        : never

/**
 * What `T` becomes once it is collected under a multi-binding injection.
 *
 * A {@link Provider} keeps its wrapper on the outside: `$i.allOf($i.provide(key))` resolves to one provider whose
 * `get()` returns the whole array, because the runtime dispatches the multiple flag inside the provider resolver
 * rather than around it.
 */
type CollectedInjection<T> = T extends Provider<infer U> ? Provider<U[]> : T[]

/**
 * What `T` becomes once its injection is marked optional.
 *
 * A {@link Provider} is always delivered, so the absence moves inside the wrapper: `$i.optional($i.provide(key))`
 * resolves to a provider whose `get()` returns `undefined` while the dependency is unregistered.
 */
type OptionalInjection<T> = T extends Provider<infer U> ? Provider<U | undefined> : T | undefined

/**
 * Authoring shape for `$i.object`: property values are tokens, descriptors,
 * or nested specs. Matches runtime object-spec parsing.
 */
export type ObjectInjectionSpec = {
  [prop: string | symbol]: InjectionToken<any> | InjectionDescriptor<any> | ObjectInjectionSpec
}

/**
 * Instance bag inferred from an {@link ObjectInjectionSpec}.
 *
 * Tokens resolve to their instance type; anything carrying {@link kInjectionDescriptor} resolves to the type that
 * helper produces; every other object recurses as a nested bag. A descriptor therefore has to come from an `$i`
 * helper — a hand-written `{ key: … }` literal is a nested bag, here and at run time alike.
 */
export type InjectedOf<S> = { [K in keyof S]: InjectedField<S[K]> }

function encode<T>(descriptor: InjectionDescriptor<any>): InjectionResult<T> {
  // Non-enumerable: the mark is not data, so it stays out of deep-equality, `Object.entries` and any dump of a
  // descriptor. A spread therefore drops it, which is why every helper ends by encoding rather than by spreading.
  return Object.defineProperty(descriptor, kInjectionDescriptor, { value: true }) as InjectionResult<T>
}

type InjectedField<V> =
  V extends InjectionToken<infer T>
    ? T
    : V extends { readonly [kInjectionDescriptor]: true; readonly [kInjectionResult]: infer T }
      ? T
      : V extends object
        ? InjectedOf<V>
        : never

/**
 * allOf creates an injection descriptor that injects all bindings associated with given key.
 *
 * @param keyOrDescriptor - The key or descriptor to inject all bindings for.
 *
 * @example
 * ```ts
 * abstract class Validator {
 *   abstract validate(value: unknown): string
 * }
 *
 * class ValidatorA extends Validator {
 *   validate(value: unknown): string {
 *     return 'A'
 *   }
 * }
 *
 * class ValidatorB extends Validator {
 *   validate(value: unknown): string {
 *     return 'B'
 *   }
 * }
 *
 * @Injectable([$i.allOf(Validator)])
 * class Pipeline {
 *   constructor(readonly validators: Validator[]) {}
 * }
 * ```
 */
function allOf<K extends InjectionToken<any> | InjectionDescriptor<any>>(
  keyOrDescriptor: K,
): InjectionResult<CollectedInjection<ResolveInjection<K>>> {
  if (typeof keyOrDescriptor === 'object' && keyOrDescriptor !== null) {
    const descriptor = keyOrDescriptor as InjectionDescriptor

    if (!isValidKey(descriptor.key)) {
      throw new ErrMissingInjectionKey(
        `Cannot call 'allOf': descriptor does not have a valid key` +
          solutions(
            `- Pass a key directly or use an injection function that resolves to a key, e.g. allOf(optional(key))`,
            `- A circular module import may have caused the key to be undefined at declaration time — use allOf(defer(() => ClassName)) to defer resolution`,
          ),
      )
    }

    return encode({ ...descriptor, multiple: true })
  }

  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'allOf': key is null or undefined`)
  }

  return encode({ key: keyOrDescriptor as InjectionToken, multiple: true, resolver: BuiltInResolvers.DEFAULT })
}

/**
 * ordered creates an injection descriptor that injects all bindings associated with the given key,
 * sorted by their configured {@link Order} value (ascending). Bindings without an order are placed last,
 * preserving their original registration order among themselves.
 *
 * @param keyOrDescriptor - The key or descriptor to inject all ordered bindings for.
 *
 * @example
 * ```ts
 * abstract class Handler {
 *   abstract handle(): void
 * }
 *
 * @Order(1)
 * @Injectable()
 * class AuthHandler extends Handler { ... }
 *
 * @Order(2)
 * @Injectable()
 * class LogHandler extends Handler { ... }
 *
 * @Injectable([$i.ordered(Handler)])
 * class Pipeline {
 *   constructor(readonly handlers: Handler[]) {} // [AuthHandler, LogHandler]
 * }
 * ```
 */
function ordered<K extends InjectionToken<any> | InjectionDescriptor<any>>(
  keyOrDescriptor: K,
): InjectionResult<ResolveInjection<K>[]> {
  if (typeof keyOrDescriptor === 'object' && keyOrDescriptor !== null) {
    const descriptor = keyOrDescriptor as InjectionDescriptor

    if (!isValidKey(descriptor.key)) {
      throw new ErrMissingInjectionKey(
        `Cannot call 'ordered': descriptor does not have a valid key` +
          solutions(
            `- Pass a key directly or use an injection function that resolves to a key, e.g. ordered(optional(key))`,
            `- A circular module import may have caused the key to be undefined at declaration time — use ordered(defer(() => ClassName)) to defer resolution`,
          ),
      )
    }

    return encode({ ...descriptor, resolver: BuiltInResolvers.ORDERED })
  }

  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'ordered': key is null or undefined`)
  }

  return encode({ key: keyOrDescriptor as InjectionToken, resolver: BuiltInResolvers.ORDERED })
}

/**
 * mapped creates an injection descriptor that injects multiple bindings associated with given key
 * into a map, where the map key is the binding name and the value is the instance.
 *
 * @param keyOrDescriptor - The key or descriptor to inject into a map.
 *
 * @example
 * ```ts
 * interface Movie {}
 *
 * const kMovie = token<Movie>('movie')
 *
 * @Injectable(kMovie)
 * @Named('horror')
 * class Horror implements Movie {}
 *
 * @Injectable(kMovie)
 * @Named('comedy')
 * class Comedy implements Movie {}
 *
 * @Injectable([$i.mapped(kMovie)])
 * class MovieService {
 *   constructor(readonly movies: Map<string, Movie>) {}
 * }
 *
 * movieService.movies => [['horror', Horror], ['comedy', Comedy]]
 *
 * ```
 */
function mapped<K extends InjectionToken<any>>(key: K): InjectionResult<Map<string, ResolveInjection<K>>> {
  if (key == null) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'mapped': key is null or undefined` +
        solutions(
          `- A circular module import may have caused the key to be undefined at declaration time — use mapped(defer(() => ClassName)) to defer resolution`,
          `- Verify that the key is correctly imported`,
        ),
    )
  }

  return encode({ key, resolver: BuiltInResolvers.MAP })
}

/**
 * defer creates an injection descriptor that defers the resolution of the dependency.
 * This is dedicated to solve circular dependencies.
 *
 * @param keyFn - The function to defer the resolution of the dependency.
 *
 * @example
 * ```ts
 * @Injectable([$i.defer(() => MovieService)])
 * class MovieController {
 *   constructor(readonly movieService: MovieService) {}
 * }
 * ```
 */
function defer<K extends InjectionToken<any>>(keyFn: () => K): InjectionResult<ResolveInjection<K>> {
  return encode({ key: new DeferredCtor(keyFn), resolver: BuiltInResolvers.DEFER })
}

/**
 * optional creates an injection descriptor that makes the dependency optional.
 *
 * @param keyOrDescriptor - The key or descriptor to make optional.
 *
 * @example
 * ```ts
 * @Injectable([$i.optional(MovieService)])
 * class MovieController {
 *   constructor(readonly movieService?: MovieService) {}
 * }
 * ```
 */
function optional<K extends InjectionToken<any> | InjectionDescriptor<any>>(
  keyOrDescriptor: K,
): InjectionResult<OptionalInjection<ResolveInjection<K>>> {
  if (isValidKey(keyOrDescriptor)) {
    return encode({ key: keyOrDescriptor as InjectionToken, optional: true })
  }

  const descriptor = keyOrDescriptor as InjectionDescriptor

  if (!descriptor.resolver && !isValidKey(descriptor.key)) {
    throw new ErrMissingInjectionKey(
      `Cannot mark injection as optional: descriptor does not have a valid key.\nKey must be a string, symbol or class reference, got ${typeof descriptor.key}`,
    )
  }

  return encode({ ...descriptor, optional: true })
}

/**
 * object creates an injection descriptor that injects an object in which the properties are injected using the provided keys.
 *
 * A property value is a key, a helper from this module, or a nested spec. Every helper works, and each is resolved
 * the way the same injection would be resolved anywhere else. Properties are lazy: each resolves through its
 * binding when it is read, which is what lets one injected object hold dependencies of differing scopes.
 *
 * A descriptor has to come from a helper. An object that is not one is a nested spec — `{ svc: { key: Service } }`
 * injects nothing and yields `{ svc: { key: Service } }`; write `{ svc: Service }`.
 *
 * @param spec - The object injection plan. The object properties are the injection keys/descriptors.
 *
 * @example
 * ```ts
 * @Injectable([$i.object({
 *   movieService: MovieService,
 *   userService: $i.optional(UserService),
 *   validators: $i.ordered(Validator),
 *   region: $i.value<AppConfig>('aws.region'),
 * })])
 * class MovieController {
 *   constructor({ movieService, userService, validators, region }) {}
 * }
 * ```
 */
function object<const S extends ObjectInjectionSpec>(spec: S): InjectionResult<InjectedOf<S>> {
  return encode({ resolver: BuiltInResolvers.OBJECT, args: parseObjectSpec(spec) })
}

/**
 * provide creates an injection descriptor for a dependency wrapped with {@link Provider}.
 * Injected dependencies are resolved on every get() call.
 * This allows mixing scopes.
 * For example, a provider can inject a transient dependency into a singleton component.
 *
 * @param keyOrDescriptor - The key or descriptor to provide.
 *
 * @example
 * ```ts
 * @Injectable([$i.provide(MovieService)])
 * class MovieController {
 *   constructor(readonly movieService: Provider<MovieService>) {}
 * }
 * ```
 */
function provide<K extends InjectionToken<any> | InjectionDescriptor<any>>(
  keyOrDescriptor: K,
): InjectionResult<Provider<ResolveInjection<K>>> {
  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'provide': key is null or undefined` +
        solutions(
          `- A circular module import may have caused the key to be undefined at declaration time — use provide(defer(() => ClassName)) to defer resolution`,
          `- Verify that the key is correctly imported`,
        ),
    )
  }

  if (isValidKey(keyOrDescriptor)) {
    return encode({ key: keyOrDescriptor as InjectionToken, resolver: BuiltInResolvers.PROVIDER })
  }

  const descriptor = keyOrDescriptor as InjectionDescriptor

  if (!isValidKey(descriptor.key)) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'provide': descriptor does not have a valid key.\nKey must be a string, symbol or class reference, got ${typeof descriptor.key}`,
    )
  }

  return encode({ ...descriptor, resolver: BuiltInResolvers.PROVIDER })
}

/**
 * just creates an injection descriptor that injects a constant value.
 * Note that it accepts any value, and it does not validate undefined or null values.
 *
 * @param value - The value to inject.
 *
 * @example
 * ```ts
 * @Injectable([$i.just('Hello, world!')])
 * class HelloWorld {
 *   constructor(readonly message: string) {}
 * }
 * ```
 */
function just<T>(value: T): InjectionResult<T> {
  return encode({ resolver: BuiltInResolvers.VALUE, args: value })
}

/**
 * value creates an injection descriptor that injects a typed value from the registered
 * ValuesProvider, using either a selector function or a dot-separated string path.
 *
 * An optional second argument sets a default value returned when the resolved value is
 * `undefined` or when no provider is registered. Supplying a default prevents
 * {@link ErrNoValuesProvider} from being thrown.
 * Note that `null` is a valid value.
 *
 * @param access - Selector function or dot-path string to the desired value.
 * @param defaultValue - Default returned when the resolved value is `undefined` or the
 *   provider is absent. `null` is a valid default. Pass `undefined` (or omit) for no default.
 *
 * @example
 * ```ts
 * type AppConfig = { database: { host: string; port: number } }
 *
 * di.bindValuesProvider<AppConfig>(t => t.toValue({ database: { host: 'localhost', port: 5432 } }))
 *
 * @Injectable([
 *   $i.value<AppConfig>(cfg => cfg.database.host),
 *   $i.value<AppConfig>('database.port'),
 *   $i.value<AppConfig>('database.host', 'fallback-host'),
 * ])
 * class Repository {
 *   constructor(readonly host: string, readonly port: number, readonly fallback: string) {}
 * }
 * ```
 */
function value<T = unknown, R = any>(access: ((provider: T) => R) | string, defaultValue?: R): InjectionResult<R> {
  return encode({
    resolver: BuiltInResolvers.CONFIG,
    args: { access, defaultValue },
  })
}

/**
 * compose creates a composition of injection descriptors.
 *
 * @param key - The key to compose the injection descriptors for.
 * @param fns - The injection functions to compose.
 */
function compose(
  key: InjectionToken<any>,
  ...fns: Array<(key: InjectionToken<any>) => InjectionDescriptor<any>>
): InjectionResult<any> {
  return encode(fns.reduce((acc, fn) => ({ ...acc, ...fn(key) }), {} as InjectionDescriptor))
}

// The mark `encode` stamps, which is also the one `InjectedField` tests — so a value in a spec cannot be a
// descriptor to the compiler and a nested bag at run time, which is exactly how `just` came to throw.
function isDescriptor(value: unknown): value is InjectionDescriptor {
  return typeof value === 'object' && value !== null && kInjectionDescriptor in value
}

function parseObjectSpec(spec: ObjectInjectionSpec): ObjectInjections {
  const children: Record<string | symbol, ObjectInjection> = {}
  const props: (string | symbol)[] = [...Object.keys(spec), ...Object.getOwnPropertySymbols(spec)]

  for (const prop of props) {
    const value = spec[prop]

    if (isValidKey(value)) {
      children[prop] = { key: value as InjectionToken } satisfies ObjectInjection
    } else if (isDescriptor(value)) {
      const desc = value as InjectionDescriptor

      children[prop] = {
        key: desc.key,
        optional: desc.optional,
        multiple: desc.multiple,
        resolver: desc.resolver,
        args: desc.args,
      } satisfies ObjectInjection
    } else {
      children[prop] = parseObjectSpec(value as ObjectInjectionSpec)
    }
  }

  return { children }
}

export const $i = {
  allOf,
  value,
  ordered,
  mapped,
  defer,
  optional,
  object,
  provide,
  just,
  compose,
}
