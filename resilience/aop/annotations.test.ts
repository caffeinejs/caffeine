import { describe, expect, it } from 'vitest'

import { ErrInvalidOption } from '../errors.js'
import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from './annotations.js'

function firstLine(apply: () => unknown): string {
  try {
    apply()
  } catch (error) {
    expect(error).toBeInstanceOf(ErrInvalidOption)
    return (error as Error).message.split('\n')[0]!
  }
  throw new Error('expected the annotation to throw')
}

// A blank name can never match a definition: it fails where it is written, before the class is even defined.
describe('resilience annotations', () => {
  it.each([
    ['Retry', () => Retry('')],
    ['CircuitBreaker', () => CircuitBreaker('')],
    ['TimeLimiter', () => TimeLimiter('')],
    ['Bulkhead', () => Bulkhead('')],
    ['RateLimiter', () => RateLimiter('')],
  ])('refuses an empty name on @%s, quoting what it got', (decorator, apply) => {
    expect(firstLine(apply)).toBe(`Cannot apply @${decorator}: the name must be a non-empty string, got ""`)
  })

  // Called from plain JavaScript, or through a cast, a decorator can get anything; the message names its kind.
  it.each([
    ['a number', 42],
    ['a bigint', 1n],
    ['an object', {}],
    ['undefined', undefined],
  ])('refuses %s as a name, saying what it got', (shown, name) => {
    expect(firstLine(() => Retry(name as never))).toBe(
      `Cannot apply @Retry: the name must be a non-empty string, got ${shown}`,
    )
  })

  it.each([
    ['an empty string', '', '""'],
    ['a number', 42, 'a number'],
    ['a bigint', 1n, 'a bigint'],
  ])('refuses %s as the @Fallback method, saying what it got', (_, method, shown) => {
    expect(firstLine(() => Fallback(method as never))).toBe(
      `Cannot apply @Fallback: the method must be a non-empty string or a symbol, got ${shown}`,
    )
  })
})
