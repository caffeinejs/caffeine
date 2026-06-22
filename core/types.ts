/**
 * Ctor represents a class constructor.
 */
export type Ctor<T = any, Arguments extends unknown[] = any[]> = new (...args: Arguments) => T

/**
 * AbstractCtor represents an abstract class constructor.
 */
export type AbstractCtor<T = any, Arguments extends unknown[] = any[]> = abstract new (...args: Arguments) => T
