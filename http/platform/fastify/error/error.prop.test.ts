import { $t, validateSchema } from '@caffeinejs/application/schema'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { ProblemSchema, type Problem, type ProblemIssue, type WebApplication } from '../../../index.js'
import { createWebApplication, newRouter } from '../index.js'

/**
 * The validation problem a client gets, over violations, keys and counts no one wrote down, checked against what was
 * sent: which entries come back, how many, where they point, and that no rejected value or markup comes with them.
 */

type App = WebApplication<any, any, any, any>

const JSON_BODY = { 'content-type': 'application/json' }
const ACCEPTS = ['application/json', 'application/problem+json', 'text/markdown'] as const

function allErrors(on: boolean) {
  return { factory: { ajv: { customOptions: { allErrors: on } } } }
}

function post(app: App, path: string, body: unknown, accept?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { ...JSON_BODY, ...(accept === undefined ? {} : { accept }) },
    body: JSON.stringify(body),
  })
}

function pointerOf(entry: ProblemIssue | undefined): string | undefined {
  return (entry?.source as { pointer?: string } | undefined)?.pointer
}

// RFC 6901 §3: `~` before `/`, so a key holding `~1` is not read back as `/`.
function escaped(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

// Five kinds of rule, each failed by a value Ajv can neither coerce nor strip, and the code its failure carries.
const KINDS = [
  { schema: $t.Integer(), bad: fc.stringMatching(/^[a-z]+$/), code: 'ERR_VALIDATION_TYPE' },
  { schema: $t.String({ minLength: 3 }), bad: fc.stringMatching(/^[a-z]{0,2}$/), code: 'ERR_VALIDATION_MIN_LENGTH' },
  { schema: $t.Integer({ maximum: 10 }), bad: fc.integer({ min: 11 }), code: 'ERR_VALIDATION_MAXIMUM' },
  { schema: $t.UnionEnum(['a', 'b']), bad: fc.stringMatching(/^[c-z]{1,4}$/), code: 'ERR_VALIDATION_ENUM' },
  { schema: $t.String({ pattern: '^a+$' }), bad: fc.stringMatching(/^[b-z]+$/), code: 'ERR_VALIDATION_PATTERN' },
] as const

const FIELDS = 25
const kindOf = (i: number) => KINDS[i % KINDS.length]!
const Fields = $t.Object(
  Object.fromEntries(Array.from({ length: FIELDS }, (_, i) => [`f${i}`, $t.Optional(kindOf(i).schema)])),
)

// 1 to 25 of the fields, each with a value that breaks its rule.
const violations = fc
  .uniqueArray(fc.nat({ max: FIELDS - 1 }), { minLength: 1, maxLength: FIELDS })
  .chain(fields => fc.tuple(...fields.map(i => kindOf(i).bad.map(value => [i, value] as const))))

describe('entries name what was sent (property)', () => {
  const apps = new Map<boolean, App>()

  beforeAll(async () => {
    for (const on of [false, true]) {
      const app = createWebApplication()
        .server(() => allErrors(on))
        .mount(newRouter('/fields').post('/', { body: Fields }, () => ({ ok: true })))
      await app.bootstrap()
      apps.set(on, app)
    }
  })

  afterAll(async () => {
    for (const app of apps.values()) {
      await app.close()
    }
  })

  // A client must not rely on the order, so with every error reported the entries are compared as a set.
  it.prop([violations, fc.boolean()])(
    'lists only planted violations, and all of them with allErrors on',
    async (planted, on) => {
      const body = Object.fromEntries(planted.map(([i, value]) => [`f${i}`, value]))
      const expected = planted.map(([i]) => `/f${i} ${kindOf(i).code}`).sort()

      const problem = (await (await post(apps.get(on)!, '/fields', body)).json()) as Problem
      const listed = (problem.errors ?? []).map(entry => `${pointerOf(entry)} ${entry.code}`)

      if (on) {
        expect(listed.sort()).toEqual(expected)
      } else {
        expect(listed).toHaveLength(1)
        expect(expected).toContain(listed[0])
      }
    },
  )
})

describe('the cap holds (property)', () => {
  const CAPS = [1, 7, 25, 60] as const
  const apps = new Map<number, App>()

  beforeAll(async () => {
    for (const maxErrors of CAPS) {
      const app = createWebApplication()
        .server(() => allErrors(true))
        .errorHandling(e => e.validation({ maxErrors }))
        .mount(
          newRouter('/items').post('/', { body: $t.Object({ items: $t.Array($t.Integer()) }) }, () => ({ ok: true })),
        )
      await app.bootstrap()
      apps.set(maxErrors, app)
    }
  })

  afterAll(async () => {
    for (const app of apps.values()) {
      await app.close()
    }
  })

  it.prop([
    fc.array(fc.oneof(fc.integer(), fc.stringMatching(/^[a-z]+$/)), { maxLength: 200 }),
    fc.constantFrom(...CAPS),
  ])('sends at most maxErrors entries, and says when it cut the list', async (items, maxErrors) => {
    const bad = items.flatMap((item, i) => (typeof item === 'string' ? [`/items/${i}`] : []))
    const res = await post(apps.get(maxErrors)!, '/items', { items })

    if (bad.length === 0) {
      expect(res.status).toBe(200)
      return
    }

    const problem = (await res.json()) as Problem
    expect(res.status).toBe(422)
    expect(problem.errors).toHaveLength(Math.min(bad.length, maxErrors))
    expect(problem.errors?.every(entry => bad.includes(pointerOf(entry)!))).toBe(true)
    expect(problem.detail).toBe(
      bad.length > maxErrors
        ? `Invalid request body: showing the first ${maxErrors} of ${bad.length} errors`
        : 'Invalid request body',
    )
  })
})

describe('no rejected value comes back (property)', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication()
      .server(() => allErrors(true))
      .mount(
        newRouter('/marked').post(
          '/',
          {
            body: $t.Object({
              count: $t.Optional($t.Integer()),
              email: $t.Optional($t.String({ format: 'email' })),
              digits: $t.Optional($t.String({ pattern: '^[0-9]+$' })),
              choice: $t.Optional($t.UnionEnum(['x', 'y'])),
              short: $t.Optional($t.String({ maxLength: 4 })),
            }),
          },
          () => ({ ok: true }),
        ),
      )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // Letters only, so it fails every rule above; long enough that nothing else in a response spells it by chance.
  const marker = fc.stringMatching(/^[a-z]{16}$/).map(letters => `mk${letters}`)
  const fields = fc.subarray(['count', 'email', 'digits', 'choice', 'short'], { minLength: 1 })

  it.prop([marker, fields, fc.constantFrom(...ACCEPTS)])(
    'never echoes a value the request sent',
    async (value, names, accept) => {
      const res = await post(app, '/marked', Object.fromEntries(names.map(name => [name, value])), accept)
      const text = await res.text()

      expect(res.status).toBe(422)
      expect(text).not.toContain(value)
    },
  )
})

describe('status and location follow the slot (property)', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication().mount(
      newRouter('/slot')
        .post('/body', { body: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) }, () => ({
          ok: true,
        }))
        .get(
          '/query',
          { querystring: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) },
          () => ({ ok: true }),
        )
        .get('/path/:id', { params: $t.Object({ id: $t.Integer() }) }, () => ({ ok: true }))
        .get(
          '/header',
          { headers: $t.Unsafe({ type: 'object', patternProperties: { '^x-p-': { type: 'integer' } } }) },
          () => ({ ok: true }),
        ),
    )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  const bodyKey = fc.string({ maxLength: 12 }).filter(key => key !== '__proto__' && key !== 'constructor')
  const queryKey = fc.string({ minLength: 1, maxLength: 12 })
  const headerToken = fc.stringMatching(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,12}$/)
  const letters = fc.stringMatching(/^[A-Za-z]{1,12}$/)

  const failure = fc.oneof(
    bodyKey.map(key => ({
      send: (a: App) => post(a, '/slot/body', { [key]: 'x' }),
      status: 422,
      source: { in: 'body', pointer: `/${escaped(key)}` },
    })),
    queryKey.map(key => ({
      send: (a: App) => a.request(`/slot/query?${encodeURIComponent(key)}=x`),
      status: 400,
      source: { in: 'query', name: key },
    })),
    letters.map(value => ({
      send: (a: App) => a.request(`/slot/path/${value}`),
      status: 400,
      source: { in: 'path', name: 'id' },
    })),
    headerToken.map(token => ({
      send: (a: App) => a.request('/slot/header', { headers: { [`X-P-${token}`]: 'x' } }),
      status: 400,
      source: { in: 'header', name: `x-p-${token.toLowerCase()}` },
    })),
  )

  it.prop([failure])('answers 422 for the body and 400 for a parameter, naming where it failed', async f => {
    const res = await f.send(app)
    const problem = (await res.json()) as Problem

    expect(res.status).toBe(f.status)
    expect(problem.status).toBe(res.status)
    expect(problem.errors?.map(entry => entry.source)).toEqual([f.source])
  })
})

describe('every problem is well formed (property)', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication()
      .server(() => allErrors(true))
      .mount(
        newRouter('/any')
          .post('/', { body: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) }, () => ({
            ok: true,
          }))
          .get('/', { querystring: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) }, () => ({
            ok: true,
          })),
      )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // Keys that try to open Markdown blocks of their own: line breaks, fences, headings, frontmatter, list markers.
  const hostile = fc
    .array(
      fc.oneof(
        fc.constantFrom('\n', '\r\n', ' ', '`', '```', '#', '# ', '---', '- ', '> ', '<b>', '[a](b)', '~~~', '*'),
        fc.string({ maxLength: 4 }),
      ),
      { minLength: 1, maxLength: 5 },
    )
    .map(parts => parts.join(''))
    .filter(key => key !== '' && key !== '__proto__' && key !== 'constructor')
  const keys = fc.uniqueArray(hostile, { minLength: 1, maxLength: 5 })

  function send(slot: 'body' | 'query', names: string[], accept: string): Promise<Response> {
    if (slot === 'body') {
      return post(app, '/any', Object.fromEntries(names.map(name => [name, 'x'])), accept)
    }
    const query = names.map(name => `${encodeURIComponent(name)}=x`).join('&')
    return app.request(`/any?${query}`, { headers: { accept } })
  }

  it.prop([keys, fc.constantFrom('body', 'query'), fc.constantFrom(...ACCEPTS)], { numRuns: 300 })(
    'renders the entries as the format allows, and nothing more',
    async (names, slot, accept) => {
      const res = await send(slot, names, accept)
      const text = await res.text()

      if (accept !== 'text/markdown') {
        // TypeBox registers no `date-time` format, so the timestamp is checked on its own: ISO 8601, in UTC.
        const { timestamp, ...body } = JSON.parse(text) as Problem
        expect(new Date(timestamp!).toISOString()).toBe(timestamp)
        expect(validateSchema(ProblemSchema, body)).toEqual(expect.objectContaining({ ok: true }))
        expect(body.errors).toHaveLength(names.length)
        return
      }

      const lines = text.split('\n')
      const close = lines.indexOf('---', 1)
      const rest = lines.slice(close + 1)
      // The title, then the sections this problem has, and no heading of a key's making.
      expect(rest.filter(line => line.startsWith('#'))).toEqual([
        expect.stringMatching(/^# /),
        '## What happened',
        '## Errors',
      ])
      expect(lines.filter(line => line === '---')).toHaveLength(2)
      expect(rest.some(line => /^\s*(```|~~~)/.test(line))).toBe(false)

      const errors = rest.slice(rest.indexOf('## Errors') + 2)
      expect(errors.filter(line => line !== '').every(line => line.startsWith('- `'))).toBe(true)
      expect(errors.filter(line => line !== '')).toHaveLength(names.length)
    },
  )
})
