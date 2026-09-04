import { DeferredCtor } from './deferred_ctor.js'
import { AbstractCtor, Ctor } from './types.js'

/**
 * Represents a unique identifier within a component.
 */
export type Identifier = string | symbol

declare const kTokenType: unique symbol

/**
 * Phantom brand that attaches a value type to a named token without a runtime object.
 */
export interface TokenBrand<in out T> {
  readonly [kTokenType]: T
}

/**
 * A string or symbol branded with the type it resolves to.
 */
export type NamedToken<T> = (string & TokenBrand<T>) | (symbol & TokenBrand<T>)

type TokenKey<T, K> = [T] extends [never] ? never : unknown extends T ? never : object extends T ? never : K

/**
 * Brands a string or symbol as a named injection token.
 * The return value is the same primitive; `T` exists only at the type level.
 *
 * `T` is the resolved value type. Omitting it, or passing `any`, `unknown` or `object`, is a type error: a
 * token has to name what it resolves to.
 *
 * A class with no members is structurally `{}`, so it is rejected for the same reason — there is no type-level
 * way to tell one from `object`. Give the class a member, which is worth doing anyway: a member-less type is
 * satisfied by every value, so any assertion made against it passes vacuously.
 */
export function token<T = never>(key: TokenKey<T, string>): string & TokenBrand<T>
export function token<T = never>(key: TokenKey<T, symbol>): symbol & TokenBrand<T>
export function token<T>(key: string | symbol): NamedToken<T> {
  return key as NamedToken<T>
}

/**
 * Represents a key that is a class constructor.
 */
export type TypedKey<T> = Ctor<T> | DeferredCtor<T> | AbstractCtor<T>

/**
 * Identifies a {@link Binding} within a {@link Container} instance.
 */
export type InjectionToken<T = unknown> = TypedKey<T> | NamedToken<T>

/**
 * The value the key `K` resolves to.
 */
export type TokenValue<K> = K extends InjectionToken<infer T> ? T : never

export function isNamedKey(dep: unknown): dep is NamedToken<unknown> {
  return (typeof dep === 'string' && dep.length > 0) || typeof dep === 'symbol'
}

export function keyStr(key?: InjectionToken | Identifier): string {
  if (key === undefined) {
    return '(undefined)'
  }

  if (key instanceof DeferredCtor) {
    return keyStr(key.unwrap())
  }

  return typeof key === 'function' ? key.name : key.toString()
}

export function isValidKey(key: unknown): boolean {
  return (
    key !== undefined && key !== null && (isNamedKey(key) || typeof key === 'function' || key instanceof DeferredCtor)
  )
}
