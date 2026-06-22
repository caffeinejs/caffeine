import { DeferredCtor } from './deferred_ctor.js'
import { AbstractCtor, Ctor } from './types.js'

/**
 * Represents a unique identifier within a component.
 */
export type Identifier = string | symbol

/**
 * Represents a key that is either a string or a symbol.
 */
export type NamedKey = string | symbol

/**
 * Represents a key that is a class constructor.
 */
export type TypedKey<T> = Ctor<T> | DeferredCtor<T> | AbstractCtor<T>

/**
 * Represents a {@link Binding} key.
 * Key is used to identify a {@link Binding} within a {@link Container} instance.
 */
export type Key<T = any> = TypedKey<T> | NamedKey

export function isNamedKey(dep: unknown): dep is string | symbol {
  return (typeof dep === 'string' && dep.length > 0) || typeof dep === 'symbol'
}

export function keyStr(key?: Key): string {
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
