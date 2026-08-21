import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ErrSchemaConversion, ErrSchemaNotRepresentable } from './errors.js'
import { toJSONSchema } from './json_schema.js'
import { $t } from './t.js'

describe('toJSONSchema with TypeBox', () => {
  it('returns the schema untouched, because it already is JSON Schema', () => {
    const schema = $t.Object({ name: $t.String() })

    expect(toJSONSchema(schema, 'input', 'GET /pets body')).toBe(schema)
  })

  it('throws ErrSchemaNotRepresentable for a root $t.Undefined', () => {
    try {
      toJSONSchema($t.Undefined(), 'input', 'POST /pets body')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaNotRepresentable)

      const e = err as ErrSchemaNotRepresentable
      expect(e.code).toBe('ERR_SCHEMA_NOT_REPRESENTABLE')
      expect(e.jsonType).toBe('undefined')
      expect(e.path).toBe('')
      expect(e.message).toContain('the root schema')
      expect(e.message).toContain('$t.Optional')
    }
  })

  it('names the schema path when $t.Undefined is nested in a union', () => {
    try {
      toJSONSchema($t.Object({ note: $t.Union([$t.String(), $t.Undefined()]) }), 'input', 'POST /pets body')
      expect.unreachable()
    } catch (err) {
      const e = err as ErrSchemaNotRepresentable

      expect(e).toBeInstanceOf(ErrSchemaNotRepresentable)
      expect(e.path).toBe('properties.note.anyOf[1]')
      expect(e.message).toContain('"properties.note.anyOf[1]"')
    }
  })

  it('names the schema path when $t.Undefined is an array item', () => {
    try {
      toJSONSchema($t.Object({ tags: $t.Array($t.Undefined()) }), 'input', 'POST /pets body')
      expect.unreachable()
    } catch (err) {
      expect((err as ErrSchemaNotRepresentable).path).toBe('properties.tags.items')
    }
  })
})

describe('toJSONSchema with a Standard Schema', () => {
  it('converts through the vendor converter and strips $schema', () => {
    const converted = toJSONSchema(z.object({ name: z.string() }), 'input', 'POST /pets body')

    expect(converted).not.toHaveProperty('$schema')
    expect(converted).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
  })

  it('projects the input side for a request: a defaulted property stays optional', () => {
    const schema = z.object({ limit: z.number().default(10) })

    expect(toJSONSchema(schema, 'input', 'GET /pets querystring')).not.toHaveProperty('required')
    expect(toJSONSchema(schema, 'output', 'GET /pets response.200')).toMatchObject({ required: ['limit'] })
  })

  it('throws ErrSchemaConversion when the schema has no JSON Schema equivalent', () => {
    const schema = z.object({ id: z.bigint() })

    try {
      toJSONSchema(schema, 'input', 'POST /pets body')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaConversion)

      const e = err as ErrSchemaConversion
      expect(e.code).toBe('ERR_SCHEMA_CONVERSION')
      expect(e.vendor).toBe('zod')
      expect(e.message).toContain('POST /pets body')
      expect(e.message).toContain('BigInt')
    }
  })

  it('throws ErrSchemaConversion when the library cannot convert at all', () => {
    const opaque = {
      '~standard': { version: 1 as const, vendor: 'nojson', validate: (value: unknown) => ({ value }) },
    }

    try {
      toJSONSchema(opaque, 'input', 'POST /pets body')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaConversion)
      expect((err as ErrSchemaConversion).message).toContain('does not implement')
    }
  })

  it('drops a refinement it cannot express, which is the documented lossy edge', () => {
    const converted = toJSONSchema(
      z.object({ email: z.string().refine(v => v.includes('@')) }),
      'input',
      'POST /pets body',
    )

    expect(converted.properties).toEqual({ email: { type: 'string' } })
  })
})
