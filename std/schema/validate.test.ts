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

// `Value.Default` walks the value, so a block the input omits is never built from its children's defaults and
// fails as a missing required property. Materializing creates the declared node first — structure only, so a
// wrong value still fails exactly as it did.
describe('validateSchema with materialize', () => {
  it('builds a block the input omits entirely from its field defaults', () => {
    const schema = $t.Object({
      server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number({ default: 9999 }) }),
    })

    expect(validateSchema(schema, {}).ok).toBe(false)
    expect(validateSchema(schema, {}, { materialize: true })).toEqual({
      ok: true,
      value: { server: { host: '0.0.0.0', port: 9999 } },
    })
  })

  it('builds every level, not only the outermost', () => {
    const schema = $t.Object({
      auth: $t.Object({ github: $t.Object({ clientId: $t.String({ default: '' }) }) }),
    })

    expect(validateSchema(schema, {}, { materialize: true })).toEqual({
      ok: true,
      value: { auth: { github: { clientId: '' } } },
    })
  })

  it('leaves an optional block absent, because the author said optional', () => {
    const schema = $t.Object({ tracing: $t.Optional($t.Object({ sampleRate: $t.Number({ default: 1 }) })) })

    expect(validateSchema(schema, {}, { materialize: true })).toEqual({ ok: true, value: {} })
  })

  // The point of creating structure and not content: nothing here can invent a value nobody supplied.
  it('still fails a required field that has no default, naming the field rather than the block', () => {
    const schema = $t.Object({ auth: $t.Object({ clientId: $t.String() }) })

    const result = validateSchema(schema, {}, { materialize: true })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.issues[0].path).toBe('auth.clientId')
  })

  it('still fails a value of the wrong type', () => {
    const schema = $t.Object({ server: $t.Object({ port: $t.Number({ default: 9999 }) }) })

    expect(validateSchema(schema, { server: { port: 'abc' } }, { materialize: true }).ok).toBe(false)
  })

  it('seeds an absent block from its own default, so an object-level default still wins', () => {
    const schema = $t.Object({
      server: $t.Object({ port: $t.Number({ default: 9999 }) }, { default: { port: 8080 } }),
    })

    expect(validateSchema(schema, {}, { materialize: true })).toEqual({ ok: true, value: { server: { port: 8080 } } })
  })

  it('does not invent keys for a record, which declares none', () => {
    const schema = $t.Object({ counts: $t.Record($t.String(), $t.Integer(), { default: {} }) })

    expect(validateSchema(schema, {}, { materialize: true })).toEqual({ ok: true, value: { counts: {} } })
  })

  it('leaves a non-object where an object was declared, so the type error is still reported', () => {
    const schema = $t.Object({ server: $t.Object({ port: $t.Number({ default: 1 }) }) })

    const result = validateSchema(schema, { server: 'nope' }, { materialize: true })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.issues[0].path).toBe('server')
  })

  it('terminates on a self-referencing schema', () => {
    const node = $t.Recursive(self => $t.Object({ name: $t.String({ default: 'n' }), child: $t.Optional(self) }))

    expect(validateSchema($t.Object({ root: node }), {}, { materialize: true })).toEqual({
      ok: true,
      value: { root: { name: 'n' } },
    })
  })
})
