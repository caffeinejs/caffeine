import { $t, type AnySchema } from '@caffeinejs/application/schema'
import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ErrConfiguration } from '../error/common.js'
import { typeBoxSchemaCompiler } from './typebox.js'

function check(schema: TSchema, value: unknown): StandardSchemaV1.Result<unknown> {
  const validator = typeBoxSchemaCompiler.validator({ schema, context: 'POST /x body' })
  return validator['~standard'].validate(value) as StandardSchemaV1.Result<unknown>
}

function valueOf(schema: TSchema, value: unknown): unknown {
  const result = check(schema, value)
  if (result.issues !== undefined) {
    throw new Error(`Expected a value: ${JSON.stringify(result.issues)}`)
  }
  return result.value
}

describe('typeBoxSchemaCompiler.validator', () => {
  it('converts the strings a query or form carries into numbers and booleans', () => {
    expect(valueOf($t.Object({ num: $t.Number(), bool: $t.Boolean() }), { num: '42', bool: 'true' })).toEqual({
      num: 42,
      bool: true,
    })
  })

  it('fills a declared default', () => {
    expect(valueOf($t.Object({ page: $t.Integer({ default: 1 }) }), {})).toEqual({ page: 1 })
  })

  it('drops an undeclared key where the schema closes the object', () => {
    const schema = $t.Object({ a: $t.String() })

    expect(valueOf({ ...schema, additionalProperties: false }, { a: 'x', b: 'y' })).toEqual({ a: 'x' })
    expect(valueOf(schema, { a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' })
  })

  it('reads a duration and a list from their text', () => {
    expect(valueOf($t.Object({ ttl: $t.Duration() }), { ttl: '5s' })).toEqual({ ttl: 5000 })
    expect(valueOf($t.Object({ tags: $t.List($t.String()) }), { tags: 'a,b' })).toEqual({ tags: ['a', 'b'] })
  })

  it('refuses a value that breaks a format, naming the keyword', () => {
    const schema = $t.String({ format: 'email' })
    const refused = check(schema, 'x')

    const issues = (refused.issues ?? []) as readonly { code?: string }[]

    expect(issues.length).toBe(1)
    expect(issues[0]?.code).toBe('format')
    expect(valueOf(schema, 'a@b.co')).toBe('a@b.co')
  })

  it('throws ErrConfiguration naming the slot for a schema TypeBox cannot check', () => {
    const compile = () => typeBoxSchemaCompiler.validator({ schema: $t.Unsafe({}), context: 'POST /x body' })

    expect(compile).toThrow(ErrConfiguration)
    expect(compile).toThrow('"POST /x body"')
  })

  // TypeBox refuses a `pattern` it cannot compile in its own preflight check.
  it('throws ErrConfiguration naming the slot for a pattern TypeBox refuses', () => {
    const compile = () =>
      typeBoxSchemaCompiler.validator({ schema: $t.String({ pattern: '[' }), context: 'POST /x body' })

    expect(compile).toThrow(ErrConfiguration)
    expect(compile).toThrow('"POST /x body"')
  })

  it('throws ErrConfiguration for a patternProperties key that is not a regular expression', () => {
    const compile = () =>
      typeBoxSchemaCompiler.validator({
        schema: $t.Object({}, { patternProperties: { '[': $t.String() } }),
        context: 'POST /x body',
      })

    expect(compile).toThrow(ErrConfiguration)
    expect(compile).toThrow('is not a valid regular expression')
  })
})

describe('typeBoxSchemaCompiler.serializer', () => {
  const write = (schema: AnySchema, value: unknown) =>
    typeBoxSchemaCompiler.serializer({ schema, context: 'GET /x response 200' })(value)

  it('writes only the declared properties', () => {
    expect(write($t.Object({ a: $t.Number() }), { a: 1, b: 2 })).toBe('{"a":1}')
  })

  it('encodes a duration back to its text', () => {
    expect(write($t.Object({ ttl: $t.Duration() }), { ttl: 5000 })).toBe('{"ttl":"5s"}')
  })

  it('writes a Zod schema the same way', () => {
    expect(write(z.object({ a: z.number() }), { a: 1, b: 2 })).toBe('{"a":1}')
  })

  // On the way in a client may omit a defaulted property; on the way out it is always there.
  it('writes a Standard Schema response from its output side', () => {
    const schema = z.object({ limit: z.number().default(10) })

    expect(write(schema, { limit: 3 })).toBe('{"limit":3}')
    expect(write(schema, {})).toBe('{"limit":10}')
  })
})
