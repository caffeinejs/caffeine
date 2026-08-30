import { DeferredCtor } from './deferred_ctor.js'
import { AbstractCtor, Ctor } from './types.js'

/**
 * Represents a unique identifier within a component.
 */
export type Identifier = string | symbol

declare const kTokenType: unique symbol
declare const kTokenNeedsType: unique symbol

/**
 * Phantom brand that attaches a value type to a named token without a runtime object.
 */
export interface TokenBrand<in out T> {
  readonly [kTokenType]: T
}

type TokenNeedsTypeArg = { readonly [kTokenNeedsType]: true }

/**
 * A string or symbol branded with the type it resolves to.
 */
export type NamedToken<T> = (string & TokenBrand<T>) | (symbol & TokenBrand<T>)

/**
 * Brands a string or symbol as a named injection token.
 * The return value is the same primitive; `T` exists only at the type level.
 */
export function token<T = never>(key: string): [T] extends [never] ? TokenNeedsTypeArg : string & TokenBrand<T>
export function token<T = never>(key: symbol): [T] extends [never] ? TokenNeedsTypeArg : symbol & TokenBrand<T>
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
