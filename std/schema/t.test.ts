import { Value } from '@sinclair/typebox/value'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { InferSchema } from './schema.js'
import { $t } from './t.js'

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
        status: { anyOf: [{ const: 'draft', type: 'string' }, { const: 'live', type: 'string' }] },
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
    expect(JSON.parse(JSON.stringify(schema.properties.note)))
      .toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
  })

  it('Partial makes every property optional, which is the update-DTO shape', () => {
    const Create = $t.Object({ name: $t.String(), age: $t.Number() })

    expect($t.Partial(Create).required).toBeUndefined()
    expect(Object.keys($t.Partial(Create).properties)).toEqual(['name', 'age'])
  })

  it('UnionEnum is a literal union, so TypeBox Value can still check it', () => {
    const schema = $t.UnionEnum(['A', 'B'])

    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      anyOf: [{ const: 'A', type: 'string' }, { const: 'B', type: 'string' }],
    })
    expect(Value.Check(schema, 'A')).toBe(true)
    expect(Value.Check(schema, 'B')).toBe(true)
    expect(Value.Check(schema, 'C')).toBe(false)
    expectTypeOf<InferSchema<typeof schema>>().toEqualTypeOf<'A' | 'B'>()
  })
})
