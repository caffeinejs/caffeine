import { describe, expect, it } from 'vitest'
import { textList } from './text.js'

describe('textList', () => {
  it('splits on the default separator', () => {
    expect(textList('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('trims the elements, so spacing is a matter of taste', () => {
    expect(textList('a, b ,  c')).toEqual(['a', 'b', 'c'])
    expect(textList('  a,b  ')).toEqual(['a', 'b'])
  })

  it('reads a lone value as a one-element list', () => {
    // The distinction a plain array cannot make: `['solo']`, not the scalar `'solo'`.
    expect(textList('solo')).toEqual(['solo'])
  })

  it('reads an empty string as an empty list', () => {
    // The only way to clear a list a lower-priority source set. Indexed keys cannot express this at all.
    expect(textList('')).toEqual([])
    expect(textList('   ')).toEqual([])
  })

  it('keeps an empty element between two separators', () => {
    expect(textList('a,,b')).toEqual(['a', '', 'b'])
  })

  it('escapes the separator with a backslash', () => {
    expect(textList('a\\,b,c')).toEqual(['a,b', 'c'])
  })

  it('escapes a backslash with a backslash', () => {
    expect(textList('a\\\\,b')).toEqual(['a\\', 'b'])
  })

  it('keeps a trailing backslash, which escapes nothing', () => {
    expect(textList('a\\')).toEqual(['a\\'])
  })

  it('accepts a custom separator, including a multi-character one', () => {
    expect(textList('a;b;c', ';')).toEqual(['a', 'b', 'c'])
    expect(textList('a::b::c', '::')).toEqual(['a', 'b', 'c'])
    // The default separator is then just an ordinary character.
    expect(textList('a,b;c', ';')).toEqual(['a,b', 'c'])
  })

  it('passes a value that did not arrive as text straight through', () => {
    // It came from a file or the code band and is already the shape it should be.
    const list = ['a', 'b']
    expect(textList(list)).toBe(list)
    expect(textList(42)).toBe(42)
    expect(textList(undefined)).toBeUndefined()
  })
})
