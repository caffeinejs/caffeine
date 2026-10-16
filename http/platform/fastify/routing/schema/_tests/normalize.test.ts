import { $t } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { compileRouteSchema } from '../compile_route_schema.js'

const bodyOf = (schema: Parameters<typeof compileRouteSchema>[0]) =>
  JSON.parse(JSON.stringify(compileRouteSchema(schema, 'POST /pets')?.body))

describe('nullable union normalization', () => {
  it('collapses a nullable union into a type array', () => {
    expect(bodyOf({ body: $t.Object({ note: $t.Nullable($t.String()) }) }).properties.note).toEqual({
      type: ['string', 'null'],
    })
  })

  it('keeps the branch constraints when collapsing', () => {
    expect(bodyOf({ body: $t.Object({ note: $t.Nullable($t.String({ minLength: 3 })) }) }).properties.note).toEqual({
      type: ['string', 'null'],
      minLength: 3,
    })
  })

  it('collapses a nullable object', () => {
    expect(bodyOf({ body: $t.Object({ meta: $t.Nullable($t.Object({ a: $t.String() })) }) }).properties.meta).toEqual({
      type: ['object', 'null'],
      required: ['a'],
      properties: { a: { type: 'string' } },
    })
  })

  it('collapses inside arrays and nested objects', () => {
    const compiled = bodyOf({
      body: $t.Object({
        tags: $t.Array($t.Nullable($t.String())),
        nested: $t.Object({ note: $t.Nullable($t.Integer()) }),
      }),
    })

    expect(compiled.properties.tags.items).toEqual({ type: ['string', 'null'] })
    expect(compiled.properties.nested.properties.note).toEqual({ type: ['integer', 'null'] })
  })

  it('normalizes a Standard Schema nullable too', () => {
    expect(bodyOf({ body: z.object({ note: z.string().nullable() }) }).properties.note).toEqual({
      type: ['string', 'null'],
    })
  })

  it('refuses to collapse a nullable literal, where hoisting const would reject null', () => {
    const note = bodyOf({ body: $t.Object({ note: $t.Nullable($t.Literal('a')) }) }).properties.note

    expect(note.anyOf).toEqual([{ const: 'a', type: 'string' }, { type: 'null' }])
  })

  it('refuses to collapse a nullable enum', () => {
    const status = bodyOf({
      body: $t.Object({ status: $t.Nullable($t.String({ enum: ['on', 'off'] })) }),
    }).properties.status

    expect(status.anyOf).toHaveLength(2)
  })

  it('leaves a union that has no null branch alone', () => {
    const value = bodyOf({ body: $t.Object({ value: $t.Union([$t.String(), $t.Number()]) }) }).properties.value

    expect(value.anyOf).toEqual([{ type: 'string' }, { type: 'number' }])
  })

  it('leaves a three-way union alone', () => {
    const value = bodyOf({
      body: $t.Object({ value: $t.Union([$t.String(), $t.Number(), $t.Null()]) }),
    }).properties.value

    expect(value.anyOf).toHaveLength(3)
  })

  it('keeps options set on the union itself', () => {
    const note = bodyOf({
      body: $t.Object({ note: $t.Nullable($t.String(), { description: 'free text' }) }),
    }).properties.note

    expect(note).toEqual({ type: ['string', 'null'], description: 'free text' })
  })

  it('does not rewrite the authored schema', () => {
    const Note = $t.Nullable($t.String())
    const Body = $t.Object({ note: Note })

    compileRouteSchema({ body: Body }, 'POST /pets')

    expect(Note.anyOf).toHaveLength(2)
    expect(Body.properties.note).toBe(Note)
  })

  it('makes MaybeEmpty an optional nullable, which JSON Schema can express', () => {
    const compiled = bodyOf({ body: $t.Object({ note: $t.MaybeEmpty($t.String()) }) })

    expect(compiled.required).toBeUndefined()
    expect(compiled.properties.note).toEqual({ type: ['string', 'null'] })
  })
})

describe('literal union collapse', () => {
  it('collapses a same-type literal union into a typed enum', () => {
    expect(bodyOf({ body: $t.Object({ status: $t.UnionEnum(['draft', 'live']) }) }).properties.status).toEqual({
      type: 'string',
      enum: ['draft', 'live'],
    })
  })

  it('collapses $t.Union of literals the same way, so existing schemas benefit', () => {
    expect(
      bodyOf({
        body: $t.Object({ status: $t.Union([$t.Literal('draft'), $t.Literal('live')]) }),
      }).properties.status,
    ).toEqual({ type: 'string', enum: ['draft', 'live'] })
  })

  it('collapses $t.Enum too, which TypeBox also emits as anyOf of consts', () => {
    expect(
      bodyOf({ body: $t.Object({ status: $t.Enum({ Draft: 'draft', Live: 'live' }) }) }).properties.status,
    ).toEqual({ type: 'string', enum: ['draft', 'live'] })
  })

  it('collapses mixed-type literals into a bare enum, so Ajv cannot coerce between members', () => {
    expect(bodyOf({ body: $t.Object({ value: $t.UnionEnum([1, 'a']) }) }).properties.value).toEqual({ enum: [1, 'a'] })
  })

  it('refuses when a branch carries an extra keyword', () => {
    const status = bodyOf({
      body: $t.Object({
        status: $t.Union([$t.Literal('draft', { description: 'not published' }), $t.Literal('live')]),
      }),
    }).properties.status

    expect(status.anyOf).toHaveLength(2)
  })

  it('keeps options set on the union itself', () => {
    expect(
      bodyOf({
        body: $t.Object({ status: $t.UnionEnum(['draft', 'live'], { description: 'lifecycle' }) }),
      }).properties.status,
    ).toEqual({ type: 'string', enum: ['draft', 'live'], description: 'lifecycle' })
  })
})
