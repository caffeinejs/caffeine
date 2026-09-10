import { Value } from '@sinclair/typebox/value'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { InferSchema } from './schema.js'
import { $t, hasFileSchema } from './t.js'

describe('$t', () => {
  it('produces plain JSON Schema, with TypeBox markers hidden behind symbols', () => {
    const schema = $t.Object({ name: $t.String({ minLength: 1 }) })

    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    })
  })

  it('leaves additionalProperties to the consuming surface', () => {
    expect($t.Object({ name: $t.String() })).not.toHaveProperty('additionalProperties')
  })

  it('expresses Nullable as a union, never the OpenAPI nullable keyword', () => {
    const schema = $t.Nullable($t.String())

    expect(schema).not.toHaveProperty('nullable')
    expect(schema.anyOf.map(s => s.type)).toEqual(['string', 'null'])
  })

  it('emits no keyword outside JSON Schema, which Ajv in strict mode would reject', () => {
    const schema = $t.Object({
      name: $t.String({ minLength: 1 }),
      tags: $t.Array($t.String()),
      status: $t.Union([$t.Literal('draft'), $t.Literal('live')]),
      count: $t.Integer({ minimum: 0 }),
      note: $t.Optional($t.Nullable($t.String())),
      pair: $t.Tuple([$t.String(), $t.Number()]),
    })

    // A round trip through JSON is exactly what Ajv sees. `http` asserts the same schema compiles in Fastify.
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: 'object',
      required: ['name', 'tags', 'status', 'count', 'pair'],
      properties: {
        name: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' } },
        status: {
          anyOf: [
            { const: 'draft', type: 'string' },
            { const: 'live', type: 'string' },
          ],
        },
        count: { type: 'integer', minimum: 0 },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        pair: {
          type: 'array',
          items: [{ type: 'string' }, { type: 'number' }],
          additionalItems: false,
          minItems: 2,
          maxItems: 2,
        },
      },
    })
  })

  it('expresses MaybeEmpty as an optional nullable, since JSON Schema has no undefined', () => {
    const schema = $t.Object({ note: $t.MaybeEmpty($t.String()) })

    expect(schema.required).toBeUndefined()
    expect(JSON.parse(JSON.stringify(schema.properties.note))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    })
  })

  it('Partial makes every property optional, which is the update-DTO shape', () => {
    const Create = $t.Object({ name: $t.String(), age: $t.Number() })

    expect($t.Partial(Create).required).toBeUndefined()
    expect(Object.keys($t.Partial(Create).properties)).toEqual(['name', 'age'])
  })

  it('UnionEnum is a literal union, so TypeBox Value can still check it', () => {
    const schema = $t.UnionEnum(['A', 'B'])

    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      anyOf: [
        { const: 'A', type: 'string' },
        { const: 'B', type: 'string' },
      ],
    })
    expect(Value.Check(schema, 'A')).toBe(true)
    expect(Value.Check(schema, 'B')).toBe(true)
    expect(Value.Check(schema, 'C')).toBe(false)
    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<'A' | 'B'>()
  })
})

/**
 * The codecs exist because configuration arrives as text. Everything here is asserted through `Value.Decode`,
 * which is exactly how `validateConfig` reaches them.
 */
describe('$t.List', () => {
  it('decodes delimited text into a list', () => {
    expect(Value.Decode($t.List($t.String()), 'a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('passes a value that already is a list straight through', () => {
    // The same field is set from a file or the code band, where it never was text.
    expect(Value.Decode($t.List($t.String()), ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('converts the elements to the declared item type', () => {
    // Elements of a decoded list are text like everything else from an environment variable.
    expect(Value.Decode($t.List($t.Number()), '80,443')).toEqual([80, 443])
  })

  it('reads an empty string as an empty list', () => {
    expect(Value.Decode($t.List($t.String()), '')).toEqual([])
  })

  it('accepts a custom separator', () => {
    expect(Value.Decode($t.List($t.String(), { separator: ';' }), 'a;b')).toEqual(['a', 'b'])
  })

  it('accepts a parser of its own, for an encoding that is not delimited', () => {
    const schema = $t.List($t.String(), { parse: raw => raw.split('').reverse() })

    expect(Value.Decode(schema, 'abc')).toEqual(['c', 'b', 'a'])
  })

  it('rejects text whose elements do not match the item type', () => {
    // Without this the decoded value would escape unchecked: TypeBox validates a transform's encoded form and
    // never re-examines what Decode returned.
    expect(() => Value.Decode($t.List($t.Number()), 'a,b')).toThrow(/item type/)
  })

  it('types as an array of the item type', () => {
    const schema = $t.Object({ tags: $t.List($t.String()), ports: $t.List($t.Number()) })

    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<{ tags: string[]; ports: number[] }>()
  })

  it('decodes inside an object', () => {
    const schema = $t.Object({ tags: $t.List($t.String()) })

    expect(Value.Decode(schema, { tags: 'a,b' })).toEqual({ tags: ['a', 'b'] })
  })

  it('decodes inside a union, which is the shape health.signals uses', () => {
    const schema = $t.Object({
      signals: $t.Union([$t.Literal(false), $t.List($t.String())]),
    })

    expect(Value.Decode(schema, { signals: 'SIGTERM,SIGINT' })).toEqual({ signals: ['SIGTERM', 'SIGINT'] })
    expect(Value.Decode(schema, { signals: false })).toEqual({ signals: false })
  })

  it('does not try to be JSON', () => {
    // `$t.JSON($t.Array(...))` is that. A helper guessing between the two could not be named honestly.
    expect(Value.Decode($t.List($t.String()), '["a","b"]')).toEqual(['["a"', '"b"]'])
  })
})

describe('$t.JSON', () => {
  it('decodes an object', () => {
    const schema = $t.JSON($t.Object({ host: $t.String(), port: $t.Number() }))

    expect(Value.Decode(schema, '{"host":"h","port":5432}')).toEqual({ host: 'h', port: 5432 })
  })

  it('decodes an array of objects, which no delimited list can express', () => {
    const schema = $t.JSON($t.Array($t.Object({ id: $t.Number() })))

    expect(Value.Decode(schema, '[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('passes an already-structured value straight through', () => {
    const schema = $t.JSON($t.Object({ host: $t.String() }))

    expect(Value.Decode(schema, { host: 'h' })).toEqual({ host: 'h' })
  })

  it('rejects JSON that parses but is not the declared shape', () => {
    const schema = $t.JSON($t.Object({ host: $t.String() }))

    expect(() => Value.Decode(schema, '{"host":123}')).toThrow(/declared shape/)
  })

  it('rejects malformed JSON with the parser message', () => {
    const schema = $t.JSON($t.Object({ host: $t.String() }))

    expect(() => Value.Decode(schema, '{oops')).toThrow(/JSON/)
  })

  it('types as the inner schema', () => {
    const schema = $t.Object({ db: $t.JSON($t.Object({ host: $t.String() })) })

    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<{ db: { host: string } }>()
  })
})

describe('$t.Duration', () => {
  it('decodes duration text to whole milliseconds', () => {
    expect(Value.Decode($t.Duration(), '5s')).toBe(5_000)
    expect(Value.Decode($t.Duration(), '1h30m')).toBe(5_400_000)
    expect(Value.Decode($t.Duration(), '300ms')).toBe(300)
    expect(Value.Decode($t.Duration(), '1.5h')).toBe(5_400_000)
  })

  it('decodes inside an object', () => {
    const schema = $t.Object({ ttl: $t.Duration() })

    expect(Value.Decode(schema, { ttl: '2s' })).toEqual({ ttl: 2_000 })
  })

  it('rejects a string that is not a duration', () => {
    // The pattern is the whole point: without it parseDuration would read these as 0 and the misconfiguration
    // would reach a timer silently.
    expect(() => Value.Decode($t.Duration(), '5 hours')).toThrow()
    expect(() => Value.Decode($t.Duration(), '')).toThrow()
    expect(() => Value.Decode($t.Duration(), '10x')).toThrow()
  })

  it('rejects a bare number, whose unit would be ambiguous', () => {
    expect(() => Value.Decode($t.Duration(), 5_000)).toThrow()
  })

  it('types as a number, since that is what a consumer reads back', () => {
    const schema = $t.Object({ ttl: $t.Duration() })

    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<{ ttl: number }>()
  })
})

describe('$t.File', () => {
  it('emits the JSON Schema spelling of an upload', () => {
    expect(JSON.parse(JSON.stringify($t.File()))).toEqual({ type: 'string', format: 'binary' })
  })

  it('emits an array of uploads for several files under one field', () => {
    expect(JSON.parse(JSON.stringify($t.Files()))).toEqual({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    })
  })

  it('types as the file the handler reads back', () => {
    const schema = $t.Object({ avatar: $t.File(), gallery: $t.Files() })

    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<{ avatar: File; gallery: File[] }>()
  })

  it('carries annotations through, so an upload can be described', () => {
    expect(JSON.parse(JSON.stringify($t.File({ description: 'The avatar' })))).toMatchObject({
      description: 'The avatar',
      format: 'binary',
    })
  })
})

describe('hasFileSchema', () => {
  it('recognizes a file, an array of files, and an object holding either', () => {
    expect(hasFileSchema($t.File())).toBe(true)
    expect(hasFileSchema($t.Files())).toBe(true)
    expect(hasFileSchema($t.Object({ caption: $t.String(), avatar: $t.File() }))).toBe(true)
    expect(hasFileSchema($t.Object({ gallery: $t.Files() }))).toBe(true)
  })

  it('is false for a body that carries no upload', () => {
    expect(hasFileSchema($t.Object({ name: $t.String() }))).toBe(false)
    expect(hasFileSchema($t.String())).toBe(false)
    expect(hasFileSchema($t.Array($t.String()))).toBe(false)
    expect(hasFileSchema(undefined)).toBe(false)
  })

  it('does not confuse a binary-formatted field with the format keyword elsewhere', () => {
    expect(hasFileSchema($t.Object({ when: $t.String({ format: 'date-time' }) }))).toBe(false)
  })
})
