import { DeferredCtor } from './deferred_ctor.js'
import { ErrMissingInjectionKey } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import { BuiltInResolvers } from './injection_resolver.js'
import { Key, isValidKey } from './key.js'

/**
 * InjectionDescriptor describes an injection for a component dependency.
 */
export type InjectionDescriptor<T = any> = {
  /**
   * The key of the desired dependency.
   */
  key?: Key<T>

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
export type Injection<T = unknown> = Key<T> | InjectionDescriptor<T>

type SpecValue = Key | InjectionDescriptor | ObjectInjectionSpec

type ObjectInjectionSpec = {
  [prop: string | symbol]: SpecValue
}

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
 * @Injectable([allOf(Validator)])
 * class Pipeline {
 *   constructor(readonly validators: Validator[]) {}
 * }
 * ```
 */
function allOf(keyOrDescriptor: Key | InjectionDescriptor): InjectionDescriptor {
  if (typeof keyOrDescriptor === 'object' && keyOrDescriptor !== null) {
    const descriptor = keyOrDescriptor as InjectionDescriptor

    if (!isValidKey(descriptor.key)) {
      throw new ErrMissingInjectionKey(
        `Cannot call 'allOf': descriptor does not have a valid key`
        + solutions(
          `- Pass a key directly or use an injection function that resolves to a key, e.g. allOf(optional(key))`,
          `- A circular module import may have caused the key to be undefined at declaration time — use allOf(defer(() => ClassName)) to defer resolution`,
        ),
      )
    }

    return { ...descriptor, multiple: true }
  }

  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'allOf': key is null or undefined`)
  }

  return { key: keyOrDescriptor as Key, multiple: true, resolver: BuiltInResolvers.DEFAULT }
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
 * @Injectable([ordered(Handler)])
 * class Pipeline {
 *   constructor(readonly handlers: Handler[]) {} // [AuthHandler, LogHandler]
 * }
 * ```
 */
function ordered(keyOrDescriptor: Key | InjectionDescriptor): InjectionDescriptor {
  if (typeof keyOrDescriptor === 'object' && keyOrDescriptor !== null) {
    const descriptor = keyOrDescriptor as InjectionDescriptor

    if (!isValidKey(descriptor.key)) {
      throw new ErrMissingInjectionKey(
        `Cannot call 'ordered': descriptor does not have a valid key`
        + solutions(
          `- Pass a key directly or use an injection function that resolves to a key, e.g. ordered(optional(key))`,
          `- A circular module import may have caused the key to be undefined at declaration time — use ordered(defer(() => ClassName)) to defer resolution`,
        ),
      )
    }

    return { ...descriptor, resolver: BuiltInResolvers.ORDERED }
  }

  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(`Cannot call 'ordered': key is null or undefined`)
  }

  return { key: keyOrDescriptor as Key, resolver: BuiltInResolvers.ORDERED }
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
 * @Injectable('movie')
 * @Named('horror')
 * class Horror implements Movie {}
 *
 * @Injectable('movie')
 * @Named('comedy')
 * class Comedy implements Movie {}
 *
 * @Injectable([mapped('movie')])
 * class MovieService {
 *   constructor(readonly movies: Map<string, Movie>) {}
 * }
 *
 * movieService.movies => [['horror', Horror], ['comedy', Comedy]]
 *
 * ```
 */
function mapped(key: Key): InjectionDescriptor {
  if (key == null) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'mapped': key is null or undefined`
      + solutions(
        `- A circular module import may have caused the key to be undefined at declaration time — use mapped(defer(() => ClassName)) to defer resolution`,
        `- Verify that the key is correctly imported`,
      ),
    )
  }

  return { key, resolver: BuiltInResolvers.MAP }
}

/**
 * defer creates an injection descriptor that defers the resolution of the dependency.
 * This is dedicated to solve circular dependencies.
 *
 * @param keyFn - The function to defer the resolution of the dependency.
 *
 * @example
 * ```ts
 * @Injectable([defer(() => MovieService)])
 * class MovieController {
 *   constructor(readonly movieService: MovieService) {}
 * }
 * ```
 */
function defer(keyFn: () => Key): InjectionDescriptor {
  return { key: new DeferredCtor(keyFn), resolver: BuiltInResolvers.DEFER }
}

/**
 * optional creates an injection descriptor that makes the dependency optional.
 *
 * @param keyOrDescriptor - The key or descriptor to make optional.
 *
 * @example
 * ```ts
 * @Injectable([optional(MovieService)])
 * class MovieController {
 *   constructor(readonly movieService?: MovieService) {}
 * }
 * ```
 */
function optional(keyOrDescriptor: Key | InjectionDescriptor): InjectionDescriptor {
  if (isValidKey(keyOrDescriptor)) {
    return { key: keyOrDescriptor as Key, optional: true }
  }

  const descriptor = keyOrDescriptor as InjectionDescriptor

  if (!isValidKey(descriptor.key)) {
    throw new ErrMissingInjectionKey(
      `Cannot mark injection as optional: descriptor does not have a valid key.\nKey must be a string, symbol or class reference, got ${typeof descriptor.key}`,
    )
  }

  return { ...descriptor, optional: true }
}

/**
 * object creates an injection descriptor that injects an object in which the properties are injected using the provided keys.
 *
 * @param spec - The object injection plan. The object properties are the injection keys/descriptors.
 *
 * @example
 * ```ts
 * @Injectable([object({ movieService: MovieService, userService: optional(UserService) })])
 * class MovieController {
 *   constructor({ movieService, userService }) {}
 * }
 * ```
 */
function object(spec: ObjectInjectionSpec): InjectionDescriptor {
  return { resolver: BuiltInResolvers.OBJECT, args: parseObjectSpec(spec) }
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
 * @Injectable([provide(MovieService)])
 * class MovieController {
 *   constructor(readonly movieService: Provider<MovieService>) {}
 * }
 * ```
 */
function provide(keyOrDescriptor: Key | InjectionDescriptor): InjectionDescriptor {
  if (keyOrDescriptor == null) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'provide': key is null or undefined`
      + solutions(
        `- A circular module import may have caused the key to be undefined at declaration time — use provide(defer(() => ClassName)) to defer resolution`,
        `- Verify that the key is correctly imported`,
      ),
    )
  }

  if (isValidKey(keyOrDescriptor)) {
    return { key: keyOrDescriptor as Key, resolver: BuiltInResolvers.PROVIDER }
  }

  const descriptor = keyOrDescriptor as InjectionDescriptor

  if (!isValidKey(descriptor.key)) {
    throw new ErrMissingInjectionKey(
      `Cannot call 'provide': descriptor does not have a valid key.\nKey must be a string, symbol or class reference, got ${typeof descriptor.key}`,
    )
  }

  return { ...descriptor, resolver: BuiltInResolvers.PROVIDER }
}

/**
 * value creates an injection descriptor that injects a constant value.
 * Note that it accepts any value, and it does not validate undefined or null values.
 *
 * @param value - The value to inject.
 *
 * @example
 * ```ts
 * @Injectable([useValue('Hello, world!')])
 * class HelloWorld {
 *   constructor(readonly message: string) {}
 * }
 * ```
 */
function useValue<T = unknown>(value: T): InjectionDescriptor {
  return { resolver: BuiltInResolvers.VALUE, args: value }
}

/**
 * compose creates a composition of injection descriptors.
 *
 * @param key - The key to compose the injection descriptors for.
 * @param fns - The injection functions to compose.
 */
function compose(key: Key, ...fns: Array<(key: Key) => InjectionDescriptor>): InjectionDescriptor {
  return fns.reduce((acc, fn) => ({ ...acc, ...fn(key) }), {} as InjectionDescriptor)
}

function parseObjectSpec(spec: ObjectInjectionSpec): ObjectInjections {
  const children: Record<string | symbol, ObjectInjection> = {}
  const props: (string | symbol)[] = [...Object.keys(spec), ...Object.getOwnPropertySymbols(spec)]

  for (const prop of props) {
    const value = spec[prop]

    if (isValidKey(value)) {
      children[prop] = { key: value as Key } satisfies ObjectInjection
    } else if (typeof value === 'object' && value !== null && 'key' in value) {
      const desc = value as InjectionDescriptor

      children[prop] = {
        key: desc.key!,
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
  ordered,
  mapped,
  defer,
  optional,
  object,
  provide,
  useValue,
  compose,
}
