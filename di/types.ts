/**
 * Ctor represents a class constructor.
 */
export type Ctor<T = any, Arguments extends unknown[] = any[]> = new (...args: Arguments) => T

/**
 * AbstractCtor represents an abstract class constructor.
 */
export type AbstractCtor<T = any, Arguments extends unknown[] = any[]> = abstract new (...args: Arguments) => T

/**
 * AnyClass represents any class constructor.
 */
export type AnyClass = abstract new (...args: any[]) => any

/**
 * ClassMember represents a member of a class.
 */
export type ClassMember<TClass extends AnyClass> = keyof InstanceType<TClass> | (string & {}) | (symbol & {})
