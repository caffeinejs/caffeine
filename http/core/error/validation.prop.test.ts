import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { standardIssue, validationCode } from './validation.js'

/**
 * Where an entry says a failure is, over keys no one wrote down, checked against RFC 6901 rather than against how the
 * pointer is built; and the code rule, over keyword-like strings.
 */

/** RFC 6901 §4, written from the RFC: each reference token unescaped `~1` first, then `~0`, and looked up in turn. */
function evaluate(document: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') {
    return { found: true, value: document }
  }
  if (!pointer.startsWith('/')) {
    return { found: false }
  }

  let value = document
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
      return { found: false }
    }
    value = (value as Record<string, unknown>)[key]
  }

  return { found: true, value }
}

// Keys that stress the escaping, and any others. The JSON parser refuses `__proto__` and `constructor` before
// validation, so they never reach an entry.
const key = fc
  .oneof(
    fc.constantFrom('/', '~', '~0', '~1', '~01', '', '.', '0', '12', ' ', 'a b', 'a/b~c', '😀', '\n'),
    fc.string({ maxLength: 8 }),
    fc.string({ unit: 'grapheme', maxLength: 4 }),
  )
  .filter(name => name !== '__proto__' && name !== 'constructor')

const MARKER = 'not-a-number'

describe('a body entry pointer (property)', () => {
  it.prop([fc.array(key, { minLength: 1, maxLength: 5 }), fc.dictionary(key, fc.integer(), { maxKeys: 4 })], {
    numRuns: 300,
  })('locates the one wrong leaf, under any keys', (path, siblings) => {
    const body: Record<string, unknown> = { ...siblings }
    let parent = body
    path.forEach((name, i) => {
      if (i === path.length - 1) {
        Object.defineProperty(parent, name, { value: MARKER, enumerable: true, writable: true, configurable: true })
      } else {
        const child: Record<string, unknown> = {}
        Object.defineProperty(parent, name, { value: child, enumerable: true, writable: true, configurable: true })
        parent = child
      }
    })

    const { source, detail } = standardIssue('body', { code: 'type', message: 'Expected integer', path })

    expect(source?.in).toBe('body')
    expect(evaluate(body, (source as { pointer: string }).pointer)).toEqual({ found: true, value: MARKER })
    expect(detail.startsWith(`${path.at(-1)} Expected integer`)).toBe(true)
  })
})

// Each JSON Schema keyword, as the documentation lists them.
const KEYWORDS = [
  'type',
  'required',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'additionalItems',
  'minProperties',
  'maxProperties',
  'pattern',
  'format',
  'uniqueItems',
  'enum',
  'const',
  'dependencies',
  'contains',
  'propertyNames',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'false schema',
  'additionalProperties',
]

const CODE = /^ERR_VALIDATION(_[A-Z0-9]+)*$/

const keyword = fc.oneof(
  fc.stringMatching(/^[a-z]+([A-Z][a-z0-9]*)*$/),
  fc.stringMatching(/^[A-Z]{2,}[a-z]*$/),
  fc.stringMatching(/^[$\- ]*[a-zA-Z0-9]*[$\- ]*[a-zA-Z0-9]*$/),
  fc.stringMatching(/^[^a-zA-Z0-9]*$/),
  fc.string(),
)

describe('validationCode (property)', () => {
  // A client branches on the code, so it is always one a client can match, and the same for the same keyword.
  it.prop([keyword])('gives a stable code of the documented shape for any keyword', name => {
    const code = validationCode(name)

    expect(code).toMatch(CODE)
    expect(validationCode(name)).toBe(code)
  })

  it.prop([fc.stringMatching(/^[^a-zA-Z0-9]*$/)])('gives the bare code to a keyword with no letter or digit', name => {
    expect(validationCode(name)).toBe('ERR_VALIDATION')
  })

  // Two documented keywords sharing a code would let a client mistake one failure for another.
  it('gives every documented keyword its own code', () => {
    expect(new Set(KEYWORDS.map(validationCode)).size).toBe(KEYWORDS.length)
  })
})
