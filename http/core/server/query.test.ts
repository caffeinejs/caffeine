import { describe, expect, it } from 'vitest'

import { parseQuery } from './query.js'

// Every expected value is what the parser Fastify uses today, fast-querystring 1.1.2, returns for the same input,
// so a handler reads the same query on either server.
describe('parseQuery', () => {
  it.each([
    ['a=1&a=2&a=3', { a: ['1', '2', '3'] }],
    ['a=b+c', { a: 'b c' }],
    ['a+b=1', { 'a b': '1' }],
    ['a=%20x', { a: ' x' }],
    ['k%20y=v', { 'k y': 'v' }],
    ['a=%E2%82%AC', { a: '€' }],
    ['a=%2B', { a: '+' }],
    ['flag', { flag: '' }],
    ['flag=', { flag: '' }],
    ['a&a=1', { a: ['', '1'] }],
    ['=v', { '': 'v' }],
    ['a=1=2', { a: '1=2' }],
    ['a=1&&b=2', { a: '1', b: '2' }],
    ['', {}],
    ['&', {}],
  ])('parses %j as handlers read it today', (query, expected) => {
    expect({ ...parseQuery(query) }).toEqual(expected)
  })

  // An escape that does not decode is a client's typo, not a reason to fail the request.
  it.each([
    ['a=%zz', { a: '%zz' }],
    ['%zz=1', { '%zz': '1' }],
    ['a=b+%zz', { a: 'b %zz' }],
    ['a=%E2%82', { a: '%E2%82' }],
  ])('keeps the escape of %j as written when it does not decode', (query, expected) => {
    expect({ ...parseQuery(query) }).toEqual(expected)
  })

  // A key named `__proto__` must not reach the prototype chain of what a handler reads.
  it('keeps __proto__ as a key of an object with no prototype', () => {
    const query = parseQuery('__proto__=x')

    expect(Object.getPrototypeOf(query)).toBe(null)
    expect(Object.getOwnPropertyDescriptor(query, '__proto__')?.value).toBe('x')
  })
})
