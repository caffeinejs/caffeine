import { $t } from '@caffeinejs/application/schema'
import type { FastifySchemaValidationError } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Problem, ProblemIssue, WebApplication } from '../../../index.js'
import { createWebApplication, newRouter } from '../index.js'
import { validationCode, validationDetail } from './validation.js'

type App = WebApplication<any, any, any, any>

const JSON_BODY = { 'content-type': 'application/json' }

describe('validationCode', () => {
  // One rule names every keyword, an application's own included, so a client can branch on a code no table lists.
  it.each([
    ['type', 'ERR_VALIDATION_TYPE'],
    ['minLength', 'ERR_VALIDATION_MIN_LENGTH'],
    ['exclusiveMinimum', 'ERR_VALIDATION_EXCLUSIVE_MINIMUM'],
    ['uniqueItems', 'ERR_VALIDATION_UNIQUE_ITEMS'],
    ['if', 'ERR_VALIDATION_IF'],
    ['false schema', 'ERR_VALIDATION_FALSE_SCHEMA'],
    ['$ref', 'ERR_VALIDATION_REF'],
    ['x-foo', 'ERR_VALIDATION_X_FOO'],
    ['URIRef', 'ERR_VALIDATION_URI_REF'],
    ['minContains2', 'ERR_VALIDATION_MIN_CONTAINS2'],
    ['$$', 'ERR_VALIDATION'],
    ['', 'ERR_VALIDATION'],
  ])('names %j as %s', (keyword, code) => {
    expect(validationCode(keyword)).toBe(code)
  })

  // The documented collision: keywords that differ only in separators, or in the capital that starts a word, are one
  // code. A capital inside a word splits it, so it is another code.
  it('gives keywords that differ only in separators or a leading capital the same code', () => {
    expect(validationCode('fooBar')).toBe('ERR_VALIDATION_FOO_BAR')
    expect(validationCode('FooBar')).toBe('ERR_VALIDATION_FOO_BAR')
    expect(validationCode('foo-bar')).toBe('ERR_VALIDATION_FOO_BAR')
    expect(validationCode('foobar')).toBe('ERR_VALIDATION_FOOBAR')
  })
})

describe('validationDetail', () => {
  it.each([
    ['body', 'Invalid request body'],
    ['querystring', 'Invalid query string'],
    ['params', 'Invalid path parameters'],
    ['headers', 'Invalid request headers'],
  ] as const)('names the %s slot', (slot, detail) => {
    expect(validationDetail(slot, 1, 25)).toBe(detail)
  })

  // A client reading the list must be told when it is not the whole of what failed, and only then.
  it('says how many errors a cut list leaves out', () => {
    expect(validationDetail('body', 25, 25)).toBe('Invalid request body')
    expect(validationDetail('body', 26, 25)).toBe('Invalid request body: showing the first 25 of 26 errors')
    expect(validationDetail('querystring', 3, 1)).toBe('Invalid query string: showing the first 1 of 3 errors')
  })
})

interface KeywordCase {
  keyword: string
  schema: unknown
  value: unknown
  /** The entries with `allErrors` off. */
  off: ProblemIssue[]
  /** The entries with `allErrors` on, when they differ. */
  on?: ProblemIssue[]
}

function at(code: string, detail: string, params: Record<string, unknown>, pointer = '/v'): ProblemIssue {
  return { code, detail, source: { in: 'body', pointer }, params }
}

// Each keyword Fastify's Ajv reports, failed by the member `v` of the body. A value is one Ajv can neither coerce nor
// strip, or it would pass and say nothing about the keyword.
const KEYWORDS: KeywordCase[] = [
  {
    keyword: 'type',
    schema: { type: 'integer' },
    value: 'x',
    off: [at('ERR_VALIDATION_TYPE', 'v must be integer', { type: 'integer' })],
  },
  {
    keyword: 'required',
    schema: { type: 'object', required: ['a'] },
    value: {},
    off: [at('ERR_VALIDATION_REQUIRED', "v must have required property 'a'", { missingProperty: 'a' }, '/v/a')],
  },
  {
    keyword: 'minimum',
    schema: { minimum: 5 },
    value: 1,
    off: [at('ERR_VALIDATION_MINIMUM', 'v must be >= 5', { comparison: '>=', limit: 5 })],
  },
  {
    keyword: 'maximum',
    schema: { maximum: 5 },
    value: 9,
    off: [at('ERR_VALIDATION_MAXIMUM', 'v must be <= 5', { comparison: '<=', limit: 5 })],
  },
  {
    keyword: 'exclusiveMinimum',
    schema: { exclusiveMinimum: 5 },
    value: 5,
    off: [at('ERR_VALIDATION_EXCLUSIVE_MINIMUM', 'v must be > 5', { comparison: '>', limit: 5 })],
  },
  {
    keyword: 'exclusiveMaximum',
    schema: { exclusiveMaximum: 5 },
    value: 5,
    off: [at('ERR_VALIDATION_EXCLUSIVE_MAXIMUM', 'v must be < 5', { comparison: '<', limit: 5 })],
  },
  {
    keyword: 'multipleOf',
    schema: { multipleOf: 3 },
    value: 4,
    off: [at('ERR_VALIDATION_MULTIPLE_OF', 'v must be multiple of 3', { multipleOf: 3 })],
  },
  {
    keyword: 'minLength',
    schema: { minLength: 3 },
    value: 'a',
    off: [at('ERR_VALIDATION_MIN_LENGTH', 'v must NOT have fewer than 3 characters', { limit: 3 })],
  },
  {
    keyword: 'maxLength',
    schema: { maxLength: 1 },
    value: 'ab',
    off: [at('ERR_VALIDATION_MAX_LENGTH', 'v must NOT have more than 1 characters', { limit: 1 })],
  },
  {
    keyword: 'pattern',
    schema: { type: 'string', pattern: '^a+$' },
    value: 'b',
    off: [at('ERR_VALIDATION_PATTERN', 'v must match pattern "^a+$"', { pattern: '^a+$' })],
  },
  {
    keyword: 'format',
    schema: { type: 'string', format: 'email' },
    value: 'nope',
    off: [at('ERR_VALIDATION_FORMAT', 'v must match format "email"', { format: 'email' })],
  },
  {
    keyword: 'minItems',
    schema: { type: 'array', minItems: 2 },
    value: [1],
    off: [at('ERR_VALIDATION_MIN_ITEMS', 'v must NOT have fewer than 2 items', { limit: 2 })],
  },
  {
    keyword: 'maxItems',
    schema: { type: 'array', maxItems: 1 },
    value: [1, 2],
    off: [at('ERR_VALIDATION_MAX_ITEMS', 'v must NOT have more than 1 items', { limit: 1 })],
  },
  {
    keyword: 'additionalItems',
    schema: { type: 'array', items: [{ type: 'integer' }], additionalItems: false },
    value: [1, 2],
    off: [at('ERR_VALIDATION_ADDITIONAL_ITEMS', 'v must NOT have more than 1 items', { limit: 1 })],
  },
  {
    keyword: 'minProperties',
    schema: { type: 'object', minProperties: 2 },
    value: { a: 1 },
    off: [at('ERR_VALIDATION_MIN_PROPERTIES', 'v must NOT have fewer than 2 properties', { limit: 2 })],
  },
  {
    keyword: 'maxProperties',
    schema: { type: 'object', maxProperties: 0 },
    value: { a: 1 },
    off: [at('ERR_VALIDATION_MAX_PROPERTIES', 'v must NOT have more than 0 properties', { limit: 0 })],
  },
  {
    keyword: 'uniqueItems',
    schema: { type: 'array', uniqueItems: true },
    value: ['a', 'a'],
    off: [
      at('ERR_VALIDATION_UNIQUE_ITEMS', 'v must NOT have duplicate items (items ## 0 and 1 are identical)', {
        i: 1,
        j: 0,
      }),
    ],
  },
  {
    keyword: 'enum',
    schema: { enum: ['x', 'y'] },
    value: 'z',
    off: [at('ERR_VALIDATION_ENUM', 'v must be equal to one of the allowed values', { allowedValues: ['x', 'y'] })],
  },
  {
    keyword: 'const',
    schema: { const: 'x' },
    value: 'z',
    off: [at('ERR_VALIDATION_CONST', 'v must be equal to constant', { allowedValue: 'x' })],
  },
  {
    keyword: 'dependencies',
    schema: { type: 'object', dependencies: { a: ['b'] } },
    value: { a: 1 },
    off: [
      at(
        'ERR_VALIDATION_DEPENDENCIES',
        'v must have property b when property a is present',
        { property: 'a', missingProperty: 'b', depsCount: 1, deps: 'b' },
        '/v/b',
      ),
    ],
  },
  {
    keyword: 'contains',
    schema: { type: 'array', contains: { type: 'integer' } },
    value: [{}, {}],
    off: [at('ERR_VALIDATION_CONTAINS', 'v must contain at least 1 valid item(s)', { minContains: 1 })],
    on: [
      at('ERR_VALIDATION_TYPE', '0 must be integer', { type: 'integer' }, '/v/0'),
      at('ERR_VALIDATION_TYPE', '1 must be integer', { type: 'integer' }, '/v/1'),
      at('ERR_VALIDATION_CONTAINS', 'v must contain at least 1 valid item(s)', { minContains: 1 }),
    ],
  },
  {
    keyword: 'propertyNames',
    schema: { type: 'object', propertyNames: { maxLength: 2 } },
    value: { abcd: 1 },
    off: [
      at('ERR_VALIDATION_MAX_LENGTH', 'v must NOT have more than 2 characters', { limit: 2 }),
      at('ERR_VALIDATION_PROPERTY_NAMES', 'v property name must be valid', { propertyName: 'abcd' }),
    ],
  },
  {
    keyword: 'anyOf',
    schema: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    value: {},
    off: [
      at('ERR_VALIDATION_TYPE', 'v must be string', { type: 'string' }),
      at('ERR_VALIDATION_TYPE', 'v must be integer', { type: 'integer' }),
      at('ERR_VALIDATION_ANY_OF', 'v must match a schema in anyOf', {}),
    ],
  },
  {
    keyword: 'oneOf',
    schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    value: 1,
    off: [at('ERR_VALIDATION_ONE_OF', 'v must match exactly one schema in oneOf', { passingSchemas: [0, 1] })],
  },
  {
    keyword: 'not',
    schema: { not: { type: 'string' } },
    value: 'x',
    off: [at('ERR_VALIDATION_NOT', 'v must NOT be valid', {})],
  },
  {
    keyword: 'if',
    schema: { if: { type: 'integer' }, then: { type: 'integer', minimum: 5 } },
    value: 1,
    off: [at('ERR_VALIDATION_MINIMUM', 'v must be >= 5', { comparison: '>=', limit: 5 })],
    on: [
      at('ERR_VALIDATION_MINIMUM', 'v must be >= 5', { comparison: '>=', limit: 5 }),
      at('ERR_VALIDATION_IF', 'v must match "then" schema', { failingKeyword: 'then' }),
    ],
  },
  {
    keyword: 'false schema',
    schema: false,
    value: 1,
    off: [at('ERR_VALIDATION_FALSE_SCHEMA', 'v boolean schema is false', {})],
  },
]

function keywordRouter() {
  const router = newRouter('/keywords')
  KEYWORDS.forEach((c, i) => {
    router.post(`/${i}`, { body: $t.Unsafe({ type: 'object', properties: { v: c.schema } }) }, () => ({ ok: true }))
  })
  return router
}

async function errorsOf(app: App, path: string, body: unknown): Promise<ProblemIssue[] | undefined> {
  const res = await app.request(path, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(body) })
  expect(res.status).toBe(422)
  return ((await res.json()) as Problem).errors
}

describe.each([
  { mode: 'off', allErrors: false },
  { mode: 'on', allErrors: true },
] as const)('each keyword with allErrors $mode', ({ mode, allErrors }) => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions: { allErrors } } } }))
      .mount(keywordRouter())
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // The entry contract a client branches on: a code by the rule, Ajv's message after the field, the pointer and
  // the params Ajv sent. A keyword that reports after inner errors lists them first, in Ajv's order.
  it.each(KEYWORDS.map((c, i) => [c.keyword, i, c] as const))('lists %s as documented', async (_, i, c) => {
    const expected = mode === 'on' && c.on !== undefined ? c.on : c.off

    expect(await errorsOf(app, `/keywords/${i}`, { v: c.value })).toEqual(expected)
  })
})

describe('the entries of a body', () => {
  let app: App

  // Fifty levels of `a`, an integer at the bottom.
  const deep = Array.from({ length: 50 }).reduce<object>(inner => ({ type: 'object', properties: { a: inner } }), {
    type: 'integer',
  })

  beforeAll(async () => {
    app = createWebApplication().mount(
      newRouter('/body')
        .post('/object', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .post('/open', { body: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) }, () => ({
          ok: true,
        }))
        .post('/slash', { body: $t.Unsafe({ type: 'object', required: ['a/b'] }) }, () => ({ ok: true }))
        .post(
          '/tags',
          {
            body: $t.Object({ items: $t.Array($t.Object({ tags: $t.Array($t.String()) })) }),
          },
          () => ({ ok: true }),
        )
        .post('/user', { body: $t.Object({ user: $t.Object({ email: $t.String() }) }) }, () => ({ ok: true }))
        .post('/deep', { body: $t.Unsafe(deep) }, () => ({ ok: true }))
        .post('/nullable', { body: $t.Object({ n: $t.Nullable($t.String()) }) }, () => ({ ok: true }))
        .post(
          '/formats',
          {
            body: $t.Object({
              email: $t.Optional($t.String({ format: 'email' })),
              uuid: $t.Optional($t.String({ format: 'uuid' })),
              at: $t.Optional($t.String({ format: 'date-time' })),
              uri: $t.Optional($t.String({ format: 'uri' })),
            }),
          },
          () => ({ ok: true }),
        )
        .post('/zod', { body: z.object({ email: z.email() }) }, () => ({ ok: true }))
        .post('/closed', { body: $t.Object({ a: $t.Integer() }, { additionalProperties: false }) }, ctx =>
          ctx.req.body(),
        ),
    )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // A body that is not an object fails at its root: the pointer is the body itself, and Ajv's message stands alone.
  it.each([
    ['an array', '[]'],
    ['a string', '"x"'],
    ['null', 'null'],
    ['a number', '1'],
  ])('points at the body itself when it is %s', async (_, body) => {
    const res = await app.request('/body/object', { method: 'POST', headers: JSON_BODY, body })

    expect(res.status).toBe(422)
    expect(((await res.json()) as Problem).errors).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'must be object',
        source: { in: 'body', pointer: '' },
        params: { type: 'object' },
      },
    ])
  })

  it('points at the body itself when a route that needs one gets none', async () => {
    const res = await app.request('/body/object', { method: 'POST' })

    expect(res.status).toBe(422)
    expect(((await res.json()) as Problem).errors).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'must be object',
        source: { in: 'body', pointer: '' },
        params: { type: 'object' },
      },
    ])
  })

  // JSON that does not parse never reaches the validator: it is one problem, with nothing to list.
  it('answers malformed JSON with no entries', async () => {
    const res = await app.request('/body/object', { method: 'POST', headers: JSON_BODY, body: '{' })
    const problem = (await res.json()) as Problem

    expect(res.status).toBe(400)
    expect(problem.code).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
    expect(problem).not.toHaveProperty('errors')
  })

  // Fastify's parser refuses the key before validation, so it never reaches an entry.
  it('refuses a __proto__ key before validation', async () => {
    const res = await app.request('/body/open', { method: 'POST', headers: JSON_BODY, body: '{"__proto__":{"x":1}}' })
    const problem = (await res.json()) as Problem

    expect(res.status).toBe(400)
    expect(problem.code).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
    expect(problem).not.toHaveProperty('errors')
  })

  // Under Fastify's `removeAdditional`, a member the schema closes out is dropped, not reported.
  it('lists nothing for a member the schema strips', async () => {
    const res = await app.request('/body/closed', { method: 'POST', headers: JSON_BODY, body: '{"a":1,"b":2}' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: 1 })
  })

  // RFC 6901 §3: a `/` in a member name is `~1` in the pointer, so the missing member is found where it would be.
  it('escapes a missing member appended to the pointer', async () => {
    expect(await errorsOf(app, '/body/slash', {})).toEqual([
      {
        code: 'ERR_VALIDATION_REQUIRED',
        detail: "must have required property 'a/b'",
        source: { in: 'body', pointer: '/a~1b' },
        params: { missingProperty: 'a/b' },
      },
    ])
  })

  // The pointer keeps Ajv's escaping; the field name in the detail is the key as the client wrote it.
  it.each([
    ['~1', '/~01', '~1 must be integer'],
    ['', '/', ' must be integer'],
    ['a/b', '/a~1b', 'a/b must be integer'],
  ])('points at the key %j as %j', async (key, pointer, detail) => {
    expect(await errorsOf(app, '/body/open', { [key]: 'x' })).toEqual([
      { code: 'ERR_VALIDATION_TYPE', detail, source: { in: 'body', pointer }, params: { type: 'integer' } },
    ])
  })

  // An array item's field name is its index.
  it('names an array item by its index', async () => {
    expect(await errorsOf(app, '/body/tags', { items: [{ tags: ['a', 'b', 'c', {}] }] })).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: '3 must be string',
        source: { in: 'body', pointer: '/items/0/tags/3' },
        params: { type: 'string' },
      },
    ])
  })

  // The field is the object that lacks the member, so the detail reads as Ajv wrote it, after the object's name.
  it('names a missing nested member after the object that lacks it', async () => {
    expect(await errorsOf(app, '/body/user', { user: {} })).toEqual([
      {
        code: 'ERR_VALIDATION_REQUIRED',
        detail: "user must have required property 'email'",
        source: { in: 'body', pointer: '/user/email' },
        params: { missingProperty: 'email' },
      },
    ])
  })

  it('points fifty levels deep', async () => {
    const body = Array.from({ length: 50 }).reduce<unknown>(inner => ({ a: inner }), 'x')

    expect(await errorsOf(app, '/body/deep', body)).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'a must be integer',
        source: { in: 'body', pointer: '/a'.repeat(50) },
        params: { type: 'integer' },
      },
    ])
  })

  // A nullable field compiles to a type list, which Ajv's message and params both carry.
  it('lists a nullable field by its type list', async () => {
    expect(await errorsOf(app, '/body/nullable', { n: {} })).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'n must be string,null',
        source: { in: 'body', pointer: '/n' },
        params: { type: ['string', 'null'] },
      },
    ])
  })

  it.each([
    ['email', 'email'],
    ['uuid', 'uuid'],
    ['at', 'date-time'],
    ['uri', 'uri'],
  ])('lists a bad %s as a format failure', async (field, format) => {
    expect(await errorsOf(app, '/body/formats', { [field]: 'nope' })).toEqual([
      {
        code: 'ERR_VALIDATION_FORMAT',
        detail: `${field} must match format "${format}"`,
        source: { in: 'body', pointer: `/${field}` },
        params: { format },
      },
    ])
  })

  // Zod writes an email as a pattern beside the format, and Ajv checks the pattern first.
  it('lists a Zod email as the pattern it fails first', async () => {
    const errors = await errorsOf(app, '/body/zod', { email: 'nope' })

    expect(errors?.map(entry => entry.code)).toEqual(['ERR_VALIDATION_PATTERN'])
    expect(errors?.[0]?.source).toEqual({ in: 'body', pointer: '/email' })
  })
})

describe('a Zod email with allErrors on', () => {
  it('lists the pattern, then the format', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions: { allErrors: true } } } }))
      .mount(newRouter('/zod').post('/', { body: z.object({ email: z.email() }) }, () => ({ ok: true })))
    await app.bootstrap()

    const errors = await errorsOf(app, '/zod', { email: 'nope' })

    expect(errors?.map(entry => entry.code)).toEqual(['ERR_VALIDATION_PATTERN', 'ERR_VALIDATION_FORMAT'])

    await app.close()
  })
})

describe('the entries of a parameter', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication().mount(
      newRouter('/params')
        .get('/ids', { querystring: $t.Object({ ids: $t.Array($t.Integer()) }) }, () => ({ ok: true }))
        .get('/limit', { querystring: $t.Object({ limit: $t.Integer() }) }, () => ({ ok: true }))
        .get('/some', { querystring: $t.Object({}, { minProperties: 1 }) }, () => ({ ok: true }))
        .get('/item/:id', { params: $t.Object({ id: $t.Integer() }) }, () => ({ ok: true }))
        .get('/traced', { headers: $t.Object({ 'X-Request-Id': $t.Integer() }) }, () => ({ ok: true }))
        .get('/tenant', { headers: $t.Object({ 'x-tenant': $t.String() }) }, () => ({ ok: true }))
        .post('/both/:id', { params: $t.Object({ id: $t.Integer() }), body: $t.Object({ a: $t.Integer() }) }, () => ({
          ok: true,
        })),
    )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  async function parameterErrors(path: string, init?: RequestInit): Promise<ProblemIssue[] | undefined> {
    const res = await app.request(path, init)
    expect(res.status).toBe(400)
    return ((await res.json()) as Problem).errors
  }

  // The parameter is named apart from the pointer into its value, so a client finds it as its document names it.
  it('names a repeated query parameter and points at the bad value', async () => {
    expect(await parameterErrors('/params/ids?ids=1&ids=x')).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: '1 must be integer',
        source: { in: 'query', name: 'ids', pointer: '/1' },
        params: { type: 'integer' },
      },
    ])
  })

  it('names a missing query parameter with no pointer', async () => {
    expect(await parameterErrors('/params/limit')).toEqual([
      {
        code: 'ERR_VALIDATION_REQUIRED',
        detail: "must have required property 'limit'",
        source: { in: 'query', name: 'limit' },
        params: { missingProperty: 'limit' },
      },
    ])
  })

  it('names a query parameter of the wrong type', async () => {
    expect(await parameterErrors('/params/limit?limit=abc')).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'limit must be integer',
        source: { in: 'query', name: 'limit' },
        params: { type: 'integer' },
      },
    ])
  })

  // A failure of the query string as a whole names no parameter.
  it('names no parameter when the query string as a whole fails', async () => {
    expect(await parameterErrors('/params/some')).toEqual([
      {
        code: 'ERR_VALIDATION_MIN_PROPERTIES',
        detail: 'must NOT have fewer than 1 properties',
        source: { in: 'query' },
        params: { limit: 1 },
      },
    ])
  })

  it('names a bad path parameter', async () => {
    expect(await parameterErrors('/params/item/abc')).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'id must be integer',
        source: { in: 'path', name: 'id' },
        params: { type: 'integer' },
      },
    ])
  })

  // Header names are compared without case, and Fastify validates them lowercased.
  it('names a header in lowercase whatever case the schema wrote it in', async () => {
    expect(await parameterErrors('/params/traced', { headers: { 'x-request-id': 'abc' } })).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'x-request-id must be integer',
        source: { in: 'header', name: 'x-request-id' },
        params: { type: 'integer' },
      },
    ])
  })

  it('names a missing header', async () => {
    expect(await parameterErrors('/params/tenant')).toEqual([
      {
        code: 'ERR_VALIDATION_REQUIRED',
        detail: "must have required property 'x-tenant'",
        source: { in: 'header', name: 'x-tenant' },
        params: { missingProperty: 'x-tenant' },
      },
    ])
  })

  // Fastify validates the path before the body and stops at the first slot that fails.
  it('reports only the path when the path and the body both fail', async () => {
    expect(
      await parameterErrors('/params/both/abc', { method: 'POST', headers: JSON_BODY, body: '{"a":"x"}' }),
    ).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'id must be integer',
        source: { in: 'path', name: 'id' },
        params: { type: 'integer' },
      },
    ])
  })
})

// An application can turn Ajv's messages off; the entry still reads as a sentence.
describe('an entry Ajv wrote no message for', () => {
  it('says the field is invalid', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions: { messages: false } } } }))
      .mount(newRouter('/quiet').post('/', { body: $t.Object({ name: $t.String() }) }, () => ({ ok: true })))
    await app.bootstrap()

    expect(await errorsOf(app, '/quiet', { name: {} })).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'name is invalid',
        source: { in: 'body', pointer: '/name' },
        params: { type: 'string' },
      },
    ])

    await app.close()
  })
})

// A validator the application compiled need not be Ajv: what it reports is listed by what it carries.
describe('a validator the application compiled', () => {
  function appReporting(error: unknown, logged: Array<{ level?: number; msg?: string }> = []) {
    return createWebApplication()
      .server(() => ({
        factory: { logger: { level: 'info', stream: { write: (line: string) => void logged.push(JSON.parse(line)) } } },
      }))
      .serverCallback((_kit, instance) => {
        instance.setValidatorCompiler(() => () => ({ error: error as FastifySchemaValidationError[] }))
      })
      .mount(newRouter('/own').post('/', { body: $t.Object({ sku: $t.String() }) }, () => ({ ok: true })))
  }

  // No keyword gives the bare code, no path places it at the body itself, and no params give none.
  it('lists errors that name no keyword or path', async () => {
    const app = appReporting([{ instancePath: '/sku', message: 'must be a SKU' }, { message: 'is incomplete' }])
    await app.bootstrap()

    expect(await errorsOf(app, '/own', { sku: 'x' })).toEqual([
      { code: 'ERR_VALIDATION', detail: 'sku must be a SKU', source: { in: 'body', pointer: '/sku' }, params: {} },
      { code: 'ERR_VALIDATION', detail: 'is incomplete', source: { in: 'body', pointer: '' }, params: {} },
    ])

    await app.close()
  })

  // Something other than a list of errors has nothing to count or list: the problem names the slot alone.
  it('answers a report that is not a list with the slot alone', async () => {
    const logged: Array<{ level?: number; msg?: string }> = []
    const app = appReporting('Rejected', logged)
    await app.bootstrap()

    const res = await app.request('/own', { method: 'POST', headers: JSON_BODY, body: '{"sku":"x"}' })
    const problem = (await res.json()) as Problem

    expect(res.status).toBe(422)
    expect(problem.detail).toBe('Invalid request body')
    expect(problem).not.toHaveProperty('errors')
    expect(logged.filter(entry => entry.msg === 'Invalid request body: 0 errors')).toEqual([
      expect.objectContaining({ level: 30 }),
    ])

    await app.close()
  })

  // Only Ajv's rejection of an `$async` schema is read for a list: an error that says it is Ajv's and holds none lists
  // nothing.
  it("answers an error marked as Ajv's but holding no list with the slot alone", async () => {
    const app = appReporting(Object.assign(new Error('Rejected'), { ajv: true, errors: 'none' }))
    await app.bootstrap()

    const res = await app.request('/own', { method: 'POST', headers: JSON_BODY, body: '{"sku":"x"}' })
    const problem = (await res.json()) as Problem

    expect(res.status).toBe(422)
    expect(problem.detail).toBe('Invalid request body')
    expect(problem).not.toHaveProperty('errors')

    await app.close()
  })
})
