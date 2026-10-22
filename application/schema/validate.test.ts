import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { isStandardSchema, isTypeBoxSchema, schemaVendor } from './schema.js'
import { $t } from './t.js'
import { compileEncoder, compileValidator, hasCodec, validateSchema } from './validate.js'

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

describe('compileValidator with TypeBox', () => {
  const Query = $t.Object({ timeout: $t.Duration(), tags: $t.Optional($t.List($t.String())), page: $t.Integer() })

  it('converts, checks and decodes, so the caller gets the value its type promises', () => {
    const validate = compileValidator(Query)

    expect(validate({ timeout: '5s', tags: 'a,b', page: '2' })).toEqual({
      ok: true,
      value: { timeout: 5000, tags: ['a', 'b'], page: 2 },
    })
  })

  // A large invalid value must not cost a list of every failure: the first is all a caller gets.
  it('reports the first issue only', () => {
    const validate = compileValidator($t.Object({ ids: $t.Array($t.Integer()) }))

    const result = validate({ ids: ['x', 'y', 'z'] })

    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'ids.0', message: 'Expected integer', code: expect.any(String) }],
    })
  })

  it('reports text a codec cannot read as an issue on its field', () => {
    const validate = compileValidator($t.Object({ db: $t.JSON($t.Object({ host: $t.String() })) }))

    expect(validate({ db: '{not json' })).toEqual({
      ok: false,
      issues: [{ path: 'db', message: 'The value is not valid JSON', code: 'Decode' }],
    })
  })

  it('works on the value it is handed rather than a copy', () => {
    const input = { page: '2', extra: 'x' }

    const result = compileValidator($t.Object({ page: $t.Integer() }))(input)

    expect(result.ok === true && result.value).toBe(input)
    expect(input).toEqual({ page: 2 })
  })

  it('keeps undeclared keys with clean off, for a value whose other keys are not the caller to drop', () => {
    const validate = compileValidator($t.Object({ 'x-tags': $t.List($t.String()) }), { clean: false })

    expect(validate({ 'x-tags': 'a,b', host: 'example.com' })).toEqual({
      ok: true,
      value: { 'x-tags': ['a', 'b'], host: 'example.com' },
    })
  })

  // TypeBox refuses every value of a format it does not know; the formats Fastify's Ajv checks are registered.
  it('checks a string format as Ajv does', () => {
    const validate = compileValidator(
      $t.Object({ email: $t.String({ format: 'email' }), id: $t.String({ format: 'uuid' }) }),
    )

    expect(validate({ email: 'a@b.co', id: '6f1c6f5e-4b1a-4c8e-9a39-0d5c2b7d1e2f' }).ok).toBe(true)
    expect(validate({ email: 'a@b.co', id: 'not-a-uuid' })).toMatchObject({ ok: false, issues: [{ path: 'id' }] })
  })
})

describe('compileValidator with a Standard Schema', () => {
  it('runs the library, so its refinements and transforms apply', () => {
    const validate = compileValidator(
      z.object({
        email: z.string().refine(v => v.includes('@'), 'must be an email'),
        name: z.string().transform(v => v.trim()),
      }),
    )

    expect(validate({ email: 'a@b.c', name: '  cat ' })).toEqual({ ok: true, value: { email: 'a@b.c', name: 'cat' } })
    expect(validate({ email: 'nope', name: 'cat' })).toEqual({
      ok: false,
      issues: [{ path: 'email', message: 'must be an email' }],
    })
  })

  // A large invalid value must not answer with every issue the library collected: the first is all a caller gets.
  it('reports the first issue only, however many the library collected', () => {
    const validate = compileValidator(z.object({ ids: z.array(z.number()) }))

    expect(validate({ ids: ['a', 'b', 'c'] })).toEqual({
      ok: false,
      issues: [{ path: 'ids.0', message: 'Invalid input: expected number, received string' }],
    })
  })

  it('settles with the library when it validates asynchronously', async () => {
    const validate = compileValidator(z.object({ name: z.string().refine(async v => v !== 'taken', 'is taken') }))

    await expect(validate({ name: 'taken' })).resolves.toEqual({
      ok: false,
      issues: [{ path: 'name', message: 'is taken' }],
    })
    await expect(validate({ name: 'free' })).resolves.toEqual({ ok: true, value: { name: 'free' } })
  })
})

describe('hasCodec', () => {
  it('finds a codec at any depth, and nothing in a schema without one', () => {
    expect(hasCodec($t.Object({ filter: $t.Object({ ttl: $t.Optional($t.Nullable($t.Duration())) }) }))).toBe(true)
    expect(hasCodec($t.Object({ id: $t.Integer(), tags: $t.Array($t.String()) }))).toBe(false)
    expect(hasCodec(z.object({ name: z.string().transform(v => v.trim()) }))).toBe(false)
  })
})

describe('compileEncoder', () => {
  it('runs codecs the other way, back to the text they read', () => {
    const encode = compileEncoder($t.Object({ ttl: $t.Duration(), size: $t.Bytes() }))

    expect(encode?.({ ttl: 5000, size: 2048 })).toEqual({ ttl: '5s', size: '2kb' })
  })

  it('leaves the value it is handed untouched', () => {
    const value = { ttl: 5000 }

    compileEncoder($t.Object({ ttl: $t.Duration() }))?.(value)

    expect(value).toEqual({ ttl: 5000 })
  })

  it('has nothing to do for a schema without a codec', () => {
    expect(compileEncoder($t.Object({ id: $t.Integer() }))).toBeUndefined()
    expect(compileEncoder(z.object({ id: z.number() }))).toBeUndefined()
  })
})
