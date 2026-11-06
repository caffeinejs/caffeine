import { $t } from '@caffeinejs/application/schema'
import type { FastifyError } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ErrCaffeineWebApplication } from '../../../core/error/common.js'
import { ErrHTTP, ErrHTTPUnauthorized } from '../../../core/error/http.js'
import {
  Catch,
  type ErrorHandler,
  type IContext,
  type Problem,
  type ProblemIssue,
  type WebApplication,
} from '../../../index.js'
import { createWebApplication, newRouter } from '../index.js'
import { GlobalErrorHandlerRef } from './error.js'

describe('GlobalErrorHandlerRef', () => {
  // A route group's handler falls back to the global one; reading it before the plugin ran is a wiring bug in the
  // adapter, and it must fail loudly rather than hand back `undefined`.
  it('refuses a read before the error handling plugin registered', () => {
    const ref = new GlobalErrorHandlerRef()

    expect(() => ref.handler).toThrow(ErrCaffeineWebApplication)
    expect(() => ref.handler).toThrow(
      expect.objectContaining({
        code: 'ERR_ERROR_HANDLER_NOT_INSTALLED',
        message: expect.stringMatching(
          /^Cannot read the global error handler: the error handling plugin has not registered yet/,
        ),
      }),
    )
  })

  it('hands back the handler the plugin installed', () => {
    const ref = new GlobalErrorHandlerRef()
    const handler = async () => undefined

    ref.handler = handler

    expect(ref.handler).toBe(handler)
  })
})

describe('the global error handler', () => {
  // A hook the application put on the bare server runs before the request has a context. Its failure is still
  // answered in the format the client asked for, with the request's ID, and a serializer still gets a context.
  it('answers a failure from a hook that ran before the context existed', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .serverCallback((_kit, instance) => {
        instance.addHook('onRequest', async request => {
          if (request.headers['x-api-key'] !== 'k1') {
            throw new ErrHTTPUnauthorized('Missing or unknown API key')
          }
        })
      })
      .errorHandling(e => e.serializer('text/plain', (ctx, problem) => `${problem.status} ${ctx.req.url}`))
      .mount(newRouter('/reports').get('/', () => []))
    await app.bootstrap()

    const json = await app.request('/reports', { headers: { 'x-request-id': 'gw-3' } })
    expect(json.status).toBe(401)
    expect(await json.json()).toMatchObject({ code: 'ERR_HTTP_UNAUTHORIZED', correlation_id: 'gw-3' })

    const text = await app.request('/reports', { headers: { accept: 'text/plain' } })
    expect(await text.text()).toBe('401 /reports')

    await app.close()
  })
})

@Catch(ErrHTTPUnauthorized)
class SignInHandler implements ErrorHandler<ErrHTTPUnauthorized> {
  async handle(ctx: IContext, err: ErrHTTPUnauthorized) {
    ctx.status(401)
    return { signIn: '/login', reason: err.message, requestID: ctx.req.id }
  }
}
void [SignInHandler]

describe('a failure before the context existed', () => {
  function gatedApp() {
    return createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .serverCallback((_kit, instance) => {
        instance.addHook('onRequest', async request => {
          if (request.headers['x-api-key'] !== 'k1') {
            throw new ErrHTTPUnauthorized('Missing or unknown API key')
          }
        })
      })
  }

  // An application-wide @Catch handler answers it as it answers any other, from a context of its own.
  it('reaches an enrolled @Catch handler with a context', async () => {
    const app = gatedApp()
      .errorHandling(e => e.globalHandlers(SignInHandler))
      .mount(newRouter('/reports').get('/', () => []))
    await app.bootstrap()

    const res = await app.request('/reports', { headers: { 'x-request-id': 'gw-4' } })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ signIn: '/login', reason: 'Missing or unknown API key', requestID: 'gw-4' })

    await app.close()
  })

  // A route group with handlers of its own catches it before the global handler does.
  it('reaches a route group handler with a context', async () => {
    const app = gatedApp().mount(
      newRouter('/reports')
        .catchBy([SignInHandler])
        .get('/', () => []),
    )
    await app.bootstrap()

    const res = await app.request('/reports', { headers: { 'x-request-id': 'gw-5' } })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ signIn: '/login', reason: 'Missing or unknown API key', requestID: 'gw-5' })

    await app.close()
  })
})

interface LogEntry {
  level?: number
  msg?: string
  [field: string]: unknown
}

/** Fastify's own logger, writing every line into `logged`. */
function pinoTo(logged: LogEntry[]) {
  return { level: 'info', stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } }
}

type App = WebApplication<any, any, any, any>

const JSON_BODY = { 'content-type': 'application/json' }
const JSON_UTF8 = 'application/json; charset=utf-8'
const STAMPED = { correlation_id: expect.stringMatching(/^req-/), timestamp: expect.any(String) }
const ALL_ERRORS = { factory: { ajv: { customOptions: { allErrors: true } } } }

// Three members, each failed by a value Ajv can neither coerce nor strip.
const Three = $t.Object({ a: $t.Integer(), b: $t.Integer(), c: $t.Integer() })
const THREE_BAD = JSON.stringify({ a: 'x', b: 'y', c: 'z' })

function post(app: App, path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { ...JSON_BODY, ...headers }, body })
}

async function problemOf(res: Response): Promise<Problem> {
  return (await res.json()) as Problem
}

function codesOf(problem: Problem): string[] | undefined {
  return problem.errors?.map(entry => entry.code)
}

describe('a request that fails its schema', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication().mount(
      newRouter('/slots')
        .post('/body', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/query', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/path/:a', { params: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/header', { headers: $t.Object({ 'x-a': $t.Integer() }) }, () => ({ ok: true }))
        .post('/three', { body: Three }, () => ({ ok: true })),
    )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // RFC 9110 §15.5.21: the body was understood and its content refused, which is 422. A parameter is part of the
  // request line or its headers, which a request that fails is malformed in: 400.
  it.each([
    [
      'body',
      () => post(app, '/slots/body', '{"a":"x"}'),
      422,
      'Unprocessable Content',
      'Invalid request body',
      'a',
      { in: 'body', pointer: '/a' },
    ],
    [
      'querystring',
      () => app.request('/slots/query?a=x'),
      400,
      'Bad Request',
      'Invalid query string',
      'a',
      { in: 'query', name: 'a' },
    ],
    [
      'params',
      () => app.request('/slots/path/x'),
      400,
      'Bad Request',
      'Invalid path parameters',
      'a',
      { in: 'path', name: 'a' },
    ],
    [
      'headers',
      () => app.request('/slots/header', { headers: { 'x-a': 'x' } }),
      400,
      'Bad Request',
      'Invalid request headers',
      'x-a',
      { in: 'header', name: 'x-a' },
    ],
  ] as const)(
    'answers a failing %s with its own status and detail',
    async (_, send, status, title, detail, field, source) => {
      const res = await send()

      expect(res.status).toBe(status)
      expect(res.headers.get('content-type')).toBe(JSON_UTF8)
      expect(await res.json()).toEqual({
        type: 'about:blank',
        title,
        status,
        detail,
        code: 'ERR_VALIDATION',
        errors: [
          { code: 'ERR_VALIDATION_TYPE', detail: `${field} must be integer`, source, params: { type: 'integer' } },
        ],
        ...STAMPED,
      })
    },
  )

  // Fastify ships Ajv with allErrors off, and the adapter leaves it so: one entry, however much else was wrong.
  it('lists the first error only by default', async () => {
    const problem = await problemOf(await post(app, '/slots/three', THREE_BAD))

    expect(problem.detail).toBe('Invalid request body')
    expect(codesOf(problem)).toEqual(['ERR_VALIDATION_TYPE'])
  })

  // Each format a client can ask for carries the same entries, and the response says it varies on what it asked.
  it.each([
    ['application/problem+json', 'application/problem+json; charset=utf-8'],
    ['application/json', JSON_UTF8],
    ['*/*', JSON_UTF8],
    [undefined, JSON_UTF8],
  ])('sends the entries to Accept %s', async (accept, contentType) => {
    const res = await post(app, '/slots/body', '{"a":"x"}', accept === undefined ? {} : { accept })

    expect(res.headers.get('content-type')).toBe(contentType)
    expect(res.headers.get('vary')).toBe('Accept')
    expect((await problemOf(res)).errors).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'a must be integer',
        source: { in: 'body', pointer: '/a' },
        params: { type: 'integer' },
      },
    ])
  })

  it('sends the entries to Accept text/markdown', async () => {
    const res = await post(app, '/slots/body', '{"a":"x"}', { accept: 'text/markdown' })
    const text = await res.text()

    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(text).toContain('## Errors\n\n- `body /a` `ERR_VALIDATION_TYPE`: a must be integer\n')
  })
})

describe('a validator the application compiled', () => {
  let app: App
  const logged: LogEntry[] = []

  beforeAll(async () => {
    app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .serverCallback((_kit, instance) => {
        instance.setValidatorCompiler(() => () => ({ error: new Error('Rejected by the house validator: tenant t-9') }))
      })
      .mount(
        newRouter('/house')
          .post('/', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true })),
      )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  // Its error lists nothing Ajv-shaped, and its message was written for the log: the problem names the slot alone.
  it.each([
    ['body', () => post(app, '/house', '{"a":1}'), 422, 'Invalid request body'],
    ['query string', () => app.request('/house?a=1'), 400, 'Invalid query string'],
  ] as const)('answers its failure of the %s with the slot and no entries', async (_, send, status, detail) => {
    logged.length = 0
    const res = await send()
    const text = await res.text()

    expect(res.status).toBe(status)
    expect(JSON.parse(text)).toEqual(expect.objectContaining({ status, code: 'ERR_VALIDATION', detail }))
    expect(JSON.parse(text)).not.toHaveProperty('errors')
    expect(text).not.toContain('t-9')
    expect(logged.filter(entry => entry.msg === 'Rejected by the house validator: tenant t-9')).toEqual([
      expect.objectContaining({ level: 30 }),
    ])
  })
})

// A validator that throws is the server's bug, not a request to correct: Fastify marks its error 500, and it stays one,
// for the client, for 5xx monitoring and in the error log.
describe('a validator that throws', () => {
  let app: App
  const logged: LogEntry[] = []

  beforeAll(async () => {
    app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .serverCallback((_kit, instance) => {
        instance.setValidatorCompiler(() => () => {
          throw new Error('Cannot reach the tenant registry: t-9')
        })
      })
      .mount(
        newRouter('/broken')
          .post('/', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true })),
      )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each([
    ['body', () => post(app, '/broken', '{"a":1}')],
    ['query string', () => app.request('/broken?a=1')],
  ] as const)('answers a valid %s with a 500 and logs it as an error', async (_, send) => {
    logged.length = 0
    const res = await send()
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toEqual(expect.objectContaining({ status: 500, code: 'ERR_INTERNAL' }))
    expect(JSON.parse(text)).not.toHaveProperty('errors')
    expect(text).not.toContain('t-9')
    expect(logged.filter(entry => entry.msg === 'Cannot reach the tenant registry: t-9')).toEqual([
      expect.objectContaining({ level: 50 }),
    ])
  })
})

// Ajv rejects an `$async` schema with an error of its own, its list under `errors`: the entries are a plain schema's.
describe('an $async schema', () => {
  let app: App

  beforeAll(async () => {
    app = createWebApplication().mount(
      newRouter('/later').post(
        '/',
        { body: $t.Unsafe({ $async: true, type: 'object', properties: { a: { type: 'integer' } } }) },
        () => ({ ok: true }),
      ),
    )
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it('lists the errors Ajv rejected the body with', async () => {
    const res = await post(app, '/later', '{"a":"x"}')
    const problem = await problemOf(res)

    expect(res.status).toBe(422)
    expect(problem.detail).toBe('Invalid request body')
    expect(problem.errors).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'a must be integer',
        source: { in: 'body', pointer: '/a' },
        params: { type: 'integer' },
      },
    ])
  })
})

// A formatter decides the error's message; what the client gets is the framework's problem either way.
describe('an application schemaErrorFormatter', () => {
  it('cannot change the status or the code', async () => {
    const app = createWebApplication()
      .server(() => ({
        factory: {
          schemaErrorFormatter: () => Object.assign(new Error('teapot'), { statusCode: 418, code: 'MY_CODE' }),
        },
      }))
      .mount(newRouter('/fmt').post('/', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true })))
    await app.bootstrap()

    const res = await post(app, '/fmt', '{"a":"x"}')
    const problem = await problemOf(res)

    expect(res.status).toBe(422)
    expect(problem.code).toBe('ERR_VALIDATION')
    expect(codesOf(problem)).toEqual(['ERR_VALIDATION_TYPE'])

    await app.close()
  })
})

describe('the validation problem settings', () => {
  it('cuts the list at maxErrors and says so', async () => {
    const app = createWebApplication()
      .server(() => ALL_ERRORS)
      .errorHandling(e => e.validation({ maxErrors: 1 }))
      .mount(newRouter('/cut').post('/', { body: Three }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/cut', THREE_BAD))

    expect(problem.detail).toBe('Invalid request body: showing the first 1 of 3 errors')
    expect(problem.errors).toEqual([
      {
        code: 'ERR_VALIDATION_TYPE',
        detail: 'a must be integer',
        source: { in: 'body', pointer: '/a' },
        params: { type: 'integer' },
      },
    ])

    await app.close()
  })

  // An API that documents its own problem types sends them, on the body's 422 and a parameter's 400 alike.
  it('sends the configured type, title and code for every slot', async () => {
    const app = createWebApplication()
      .errorHandling(e =>
        e
          .validation({ type: 'https://api.example.com/problems/validation-error', title: 'Request validation failed' })
          .validation({ code: 'ERR_REQUEST_INVALID' }),
      )
      .mount(
        newRouter('/typed')
          .post('/', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true })),
      )
    await app.bootstrap()

    const configured = {
      type: 'https://api.example.com/problems/validation-error',
      title: 'Request validation failed',
      code: 'ERR_REQUEST_INVALID',
    }
    expect(await problemOf(await post(app, '/typed', '{"a":"x"}'))).toEqual(
      expect.objectContaining({ ...configured, status: 422 }),
    )
    expect(await problemOf(await app.request('/typed?a=x'))).toEqual(
      expect.objectContaining({ ...configured, status: 400 }),
    )

    await app.close()
  })
})

describe('the issue callback', () => {
  function appWith(
    issue: (ctx: IContext, entry: ProblemIssue) => ProblemIssue,
    logged: LogEntry[] = [],
    maxErrors = 25,
  ) {
    return createWebApplication()
      .server(() => ({ ...ALL_ERRORS, factory: { ...ALL_ERRORS.factory, logger: pinoTo(logged) } }))
      .errorHandling(e => e.validation({ issue, maxErrors }))
      .mount(newRouter('/mapped').post('/', { body: Three }, () => ({ ok: true })))
  }

  it('renames a code', async () => {
    const app = appWith((_ctx, entry) => ({ ...entry, code: entry.code.replace('ERR_VALIDATION_', 'E_') }))
    await app.bootstrap()

    expect(codesOf(await problemOf(await post(app, '/mapped', THREE_BAD)))).toEqual(['E_TYPE', 'E_TYPE', 'E_TYPE'])

    await app.close()
  })

  // It is handed the request's context, so an entry can be written in the client's language.
  it('writes the detail for the request it answers', async () => {
    const app = appWith((ctx, entry) =>
      ctx.req.header('accept-language') === 'pt' ? { ...entry, detail: 'valor inválido' } : entry,
    )
    await app.bootstrap()

    const pt = await problemOf(await post(app, '/mapped', THREE_BAD, { 'accept-language': 'pt' }))
    const en = await problemOf(await post(app, '/mapped', THREE_BAD, { 'accept-language': 'en' }))

    expect(pt.errors?.map(entry => entry.detail)).toEqual(['valor inválido', 'valor inválido', 'valor inválido'])
    expect(en.errors?.map(entry => entry.detail)).toEqual([
      'a must be integer',
      'b must be integer',
      'c must be integer',
    ])

    await app.close()
  })

  // A broken callback is the application's bug: the client still gets every entry, and the log gets it once.
  it('sends the entries as built from the one that throws, and logs it once', async () => {
    const logged: LogEntry[] = []
    let calls = 0
    const app = appWith((_ctx, entry) => {
      calls += 1
      if (calls === 2) {
        throw new Error('dictionary missing')
      }
      return { ...entry, code: 'MAPPED' }
    }, logged)
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/mapped', THREE_BAD))

    expect(codesOf(problem)).toEqual(['MAPPED', 'ERR_VALIDATION_TYPE', 'ERR_VALIDATION_TYPE'])
    expect(calls).toBe(2)
    expect(
      logged.filter(
        entry => entry.msg === 'Cannot map a validation issue: sending the issues as the framework built them',
      ),
    ).toEqual([expect.objectContaining({ level: 50, err: expect.objectContaining({ message: 'dictionary missing' }) })])

    await app.close()
  })

  // A schema's constants go out in `params`; a route that must not publish them drops them here.
  it('can drop the params a schema would publish', async () => {
    const app = createWebApplication()
      .errorHandling(e => e.validation({ issue: (_ctx, { params: _, ...entry }) => entry }))
      .mount(
        newRouter('/keyed').get('/', { headers: $t.Object({ 'x-api-key': $t.Literal('k1') }) }, () => ({ ok: true })),
      )
    await app.bootstrap()

    expect((await problemOf(await app.request('/keyed', { headers: { 'x-api-key': 'nope' } }))).errors).toEqual([
      {
        code: 'ERR_VALIDATION_CONST',
        detail: 'x-api-key must be equal to constant',
        source: { in: 'header', name: 'x-api-key' },
      },
    ])

    await app.close()
  })
})

// What a schema checks against is public through its errors, which is why the docs say a schema holds no secret.
it('publishes the value a const check compares against', async () => {
  const app = createWebApplication().mount(
    newRouter('/keyed').get('/', { headers: $t.Object({ 'x-api-key': $t.Literal('k1') }) }, () => ({ ok: true })),
  )
  await app.bootstrap()

  expect(
    (await problemOf(await app.request('/keyed', { headers: { 'x-api-key': 'nope' } }))).errors?.[0]?.params,
  ).toEqual({ allowedValue: 'k1' })

  await app.close()
})

@Catch(Error)
class ValidationEcho implements ErrorHandler<FastifyError> {
  async handle(ctx: IContext, err: FastifyError) {
    ctx.status(409)
    return { message: err.message, slot: err.validationContext, reported: err.validation?.length }
  }
}
void [ValidationEcho]

describe('precedence', () => {
  // A route's own handler is handed Fastify's error, its validation array included, before anything is rendered.
  it('hands a failure to the route group handler first', async () => {
    const app = createWebApplication()
      .server(() => ALL_ERRORS)
      .mount(
        newRouter('/own')
          .catchBy([ValidationEcho])
          .post('/', { body: Three }, () => ({ ok: true })),
      )
    await app.bootstrap()

    const res = await post(app, '/own', THREE_BAD)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ message: 'Invalid request body: 3 errors', slot: 'body', reported: 3 })

    await app.close()
  })

  // A body the error carries is the author's own, whatever entries it was also given.
  it('sends the body an ErrHTTP carries over its entries', async () => {
    const app = createWebApplication().mount(
      newRouter('/carried').post('/', () => {
        throw ErrHTTP.builder()
          .statusCode(422)
          .body({ rejected: true })
          .errors({ code: 'ERR_ITEM_UNAVAILABLE', detail: 'Item 7 is sold out' })
          .build()
      }),
    )
    await app.bootstrap()

    const res = await post(app, '/carried', '{}')

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ rejected: true })

    await app.close()
  })
})

describe('the volume a request can make', () => {
  // 10,000 failing items, about 30 KiB, well under the body limit.
  const MANY = JSON.stringify({ items: Array.from({ length: 10_000 }, () => ({})) })
  const Many = $t.Object({ items: $t.Array($t.Integer()) })
  // Thirty branches, each failed, and the anyOf itself.
  const Branches = $t.Unsafe({
    type: 'object',
    properties: { v: { anyOf: Array.from({ length: 30 }, (_, i) => ({ const: i })) } },
  })

  it('lists one entry for 10,000 failing items by default', async () => {
    const app = createWebApplication().mount(newRouter('/many').post('/', { body: Many }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/many', MANY))

    expect(problem.detail).toBe('Invalid request body')
    expect(problem.errors).toHaveLength(1)

    await app.close()
  })

  it('lists 25 entries for 10,000 failing items with allErrors on', async () => {
    const app = createWebApplication()
      .server(() => ALL_ERRORS)
      .mount(newRouter('/many').post('/', { body: Many }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/many', MANY))

    expect(problem.detail).toBe('Invalid request body: showing the first 25 of 10000 errors')
    expect(problem.errors).toHaveLength(25)
    expect(problem.errors?.[24]?.source).toEqual({ in: 'body', pointer: '/items/24' })

    await app.close()
  })

  // anyOf reports every branch even with allErrors off, so the cap applies there too.
  it('cuts an anyOf of 30 failing branches at 25 by default', async () => {
    const app = createWebApplication().mount(newRouter('/branches').post('/', { body: Branches }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/branches', '{"v":"x"}'))

    expect(problem.detail).toBe('Invalid request body: showing the first 25 of 31 errors')
    expect(codesOf(problem)).toEqual(Array.from({ length: 25 }, () => 'ERR_VALIDATION_CONST'))

    await app.close()
  })
})

describe('what one unauthenticated request can cost', () => {
  // 1,000 items, each missing 20 required members. Counts, never timings, so the test holds on any machine.
  const Twenty = $t.Object({
    items: $t.Array($t.Object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, $t.String()])))),
  })
  const EMPTY_ITEMS = JSON.stringify({ items: Array.from({ length: 1_000 }, () => ({})) })

  function validationLines(logged: LogEntry[]): LogEntry[] {
    return logged.filter(entry => entry.validation !== undefined)
  }

  it('records one error with allErrors off', async () => {
    const logged: LogEntry[] = []
    const app = createWebApplication()
      .server(() => ({ factory: { logger: pinoTo(logged) } }))
      .mount(newRouter('/bulk').post('/', { body: Twenty }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/bulk', EMPTY_ITEMS))

    expect(problem.errors).toHaveLength(1)
    expect(validationLines(logged)).toEqual([
      expect.objectContaining({
        msg: 'Invalid request body: 1 error',
        validation: expect.objectContaining({ total: 1 }),
      }),
    ])

    await app.close()
  })

  // The log line is bounded like the response, and the callback does no work past the cap.
  it('logs one bounded line for 20,000 errors with allErrors on', async () => {
    const logged: LogEntry[] = []
    let calls = 0
    const app = createWebApplication()
      .server(() => ({ factory: { ...ALL_ERRORS.factory, logger: pinoTo(logged) } }))
      .errorHandling(e =>
        e.validation({
          issue: (_ctx, entry) => {
            calls += 1
            return entry
          },
        }),
      )
      .mount(newRouter('/bulk').post('/', { body: Twenty }, () => ({ ok: true })))
    await app.bootstrap()

    const problem = await problemOf(await post(app, '/bulk', EMPTY_ITEMS))

    expect(problem.detail).toBe('Invalid request body: showing the first 25 of 20000 errors')
    expect(problem.errors).toHaveLength(25)
    expect(calls).toBe(25)

    const lines = validationLines(logged)
    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'Invalid request body: 20000 errors',
        validation: { slot: 'body', total: 20000, errors: problem.errors },
      }),
    ])
    expect(lines[0]).not.toHaveProperty('err')
    expect(logged.some(entry => entry.err !== undefined)).toBe(false)

    await app.close()
  })

  describe('a key the client chose', () => {
    let app: App
    const IMG = '<img src=x onerror=alert(1)>'

    beforeAll(async () => {
      app = createWebApplication()
        .server(() => ALL_ERRORS)
        .mount(
          newRouter('/open').get(
            '/',
            { querystring: $t.Unsafe({ type: 'object', additionalProperties: { type: 'integer' } }) },
            () => ({ ok: true }),
          ),
        )
      await app.bootstrap()
    })

    afterAll(async () => {
      await app.close()
    })

    // Returned as JSON, never HTML, and as the exact string sent: escaping is the job of whatever renders it.
    it('comes back as written, in JSON', async () => {
      const res = await app.request(`/open?${encodeURIComponent(IMG)}=x`)

      expect(res.headers.get('content-type')).toBe(JSON_UTF8)
      expect((await problemOf(res)).errors).toEqual([
        {
          code: 'ERR_VALIDATION_TYPE',
          detail: `${IMG} must be integer`,
          source: { in: 'query', name: IMG },
          params: { type: 'integer' },
        },
      ])
    })

    // In Markdown a key cannot become HTML, an image or a link with text of its own.
    it.each([
      [
        IMG,
        '- `query <img src=x onerror=alert(1)>` `ERR_VALIDATION_TYPE`: \\<img src=x onerror=alert(1)\\> must be integer',
      ],
      [
        '[x](https://example.com)',
        '- `query [x](https://example.com)` `ERR_VALIDATION_TYPE`: \\[x\\](https://example.com) must be integer',
      ],
    ])('is escaped in Markdown: %s', async (key, line) => {
      const res = await app.request(`/open?${encodeURIComponent(key)}=x`, { headers: { accept: 'text/markdown' } })

      expect((await res.text()).split('\n')).toContain(line)
    })

    // Entries are built in arrays: a key the client chose never becomes a property of anything.
    it('lists prototype keys as plain data and leaves Object.prototype alone', async () => {
      const before = Object.getOwnPropertyNames(Object.prototype).sort()

      const res = await app.request('/open?__proto__=x&constructor=y&prototype=z')
      const problem = await problemOf(res)

      expect(res.status).toBe(400)
      expect(problem.errors?.map(entry => entry.source)).toEqual(
        expect.arrayContaining([
          { in: 'query', name: '__proto__' },
          { in: 'query', name: 'constructor' },
          { in: 'query', name: 'prototype' },
        ]),
      )
      expect(problem.errors).toHaveLength(3)
      expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
      expect(({} as Record<string, unknown>).x).toBe(undefined)
    })
  })
})
