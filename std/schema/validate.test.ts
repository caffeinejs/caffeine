import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isStandardSchema, isTypeBoxSchema, schemaVendor } from './schema.js'
import { $t } from './t.js'
import { validateSchema } from './validate.js'

describe('schema detection', () => {
  it('tells the two dialects apart', () => {
    const tb = $t.Object({ a: $t.String() })
    const zod = z.object({ a: z.string() })

    expect(isTypeBoxSchema(tb)).toBe(true)
    expect(isStandardSchema(tb)).toBe(false)
    expect(isStandardSchema(zod)).toBe(true)
    expect(isTypeBoxSchema(zod)).toBe(false)
    expect(schemaVendor(tb)).toBe('typebox')
    expect(schemaVendor(zod)).toBe('zod')
  })

  it('rejects non-objects', () => {
    expect(isTypeBoxSchema(null)).toBe(false)
    expect(isStandardSchema('string')).toBe(false)
  })
})

describe('validateSchema with TypeBox', () => {
  const schema = $t.Object({
    host: $t.String({ default: 'localhost' }),
    port: $t.Number({ default: 8080 }),
    debug: $t.Boolean({ default: false }),
  })

  it('applies defaults, coerces, and drops undeclared keys', () => {
    const result = validateSchema(schema, { port: '3000', debug: 'true', extra: 'dropped' })

    expect(result).toEqual({ ok: true, value: { host: 'localhost', port: 3000, debug: true } })
  })

  it('reports dotted paths for nested failures', () => {
    const nested = $t.Object({ server: $t.Object({ port: $t.Number() }) })
    const result = validateSchema(nested, { server: { port: 'nope' } })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.issues[0].path).toBe('server.port')
  })

  it('never mutates the input', () => {
    const input = { port: '3000' }
    validateSchema(schema, input)

    expect(input).toEqual({ port: '3000' })
  })
})

describe('validateSchema with a Standard Schema', () => {
  it('runs the library validator, so refinements are honoured', () => {
    const schema = z.object({ email: z.string().refine(v => v.includes('@'), 'must be an email') })

    expect(validateSchema(schema, { email: 'a@b.c' })).toEqual({ ok: true, value: { email: 'a@b.c' } })

    const failure = validateSchema(schema, { email: 'nope' })
    expect(failure.ok).toBe(false)
    expect(failure.ok === false && failure.issues[0]).toEqual({ path: 'email', message: 'must be an email' })
  })

  it('applies the library transform', () => {
    const schema = z.object({ port: z.coerce.number() })

    expect(validateSchema(schema, { port: '3000' })).toEqual({ ok: true, value: { port: 3000 } })
  })

  it('reports an async validator as an issue rather than returning a Promise', () => {
    const asyncSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => Promise.resolve({ value: {} }),
      },
    }

    const result = validateSchema(asyncSchema, {})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.issues[0].message).toMatch(/Async schema validation is not supported/)
  })
})
