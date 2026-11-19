import { newNoopLogger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { Catch } from '../../decorators/index.js'
import { node, type NodeAdapter } from '../../platform/node.testkit.js'
import type { ActionResult } from '../../response.js'
import type { ErrorHandler } from '../error/handler.js'
import { ErrHTTP, ErrHTTPConflict, ErrHTTPForbidden } from '../error/http.js'
import type { Problem } from '../error/problem.js'
import { ErrRequestValidation } from '../error/validation.js'
import { Router } from '../routing/programmatic/programmatic.js'

class ErrRouteLevel extends Error {}
class ErrGroupLevel extends Error {}
class ErrGlobalLevel extends Error {}
class ErrRethrown extends Error {}

@Catch(ErrRouteLevel)
class RouteHandler implements ErrorHandler<ErrRouteLevel> {
  handle(): ActionResult {
    return { by: 'route' }
  }
}

@Catch([ErrRouteLevel, ErrGroupLevel])
class GroupHandler implements ErrorHandler<Error> {
  handle(): ActionResult {
    return { by: 'group' }
  }
}

@Catch([ErrGlobalLevel, ErrRethrown])
class GlobalHandler implements ErrorHandler<Error> {
  handle(_ctx: IContext, err: Error): ActionResult {
    return { by: 'global', name: err.constructor.name }
  }
}

@Catch(ErrRouteLevel)
class Rethrowing implements ErrorHandler<ErrRouteLevel> {
  handle(): ActionResult {
    throw new ErrRethrown('from the handler')
  }
}

const throwing = (err: Error) => () => {
  throw err
}

const scoped = new Router('/e').catchBy([GroupHandler])
scoped.get('/route').catchBy([RouteHandler]).handler(throwing(new ErrRouteLevel()))
scoped.get('/group').handler(throwing(new ErrGroupLevel()))
scoped.get('/global').handler(throwing(new ErrGlobalLevel()))
scoped.get('/rethrown').catchBy([Rethrowing]).handler(throwing(new ErrRouteLevel()))

const plain = new Router('/p')
plain.get('/conflict-body').handler(throwing(new ErrHTTPConflict('taken', { body: { taken: true } })))
plain.get('/forbidden-response').handler(throwing(new ErrHTTPForbidden('no', { body: new Response('denied') })))
plain.get('/teapot').handler(throwing(Object.assign(new Error('short and stout'), { statusCode: 418 })))
plain.get('/internal').handler(throwing(new Error('db password is hunter2')))
plain.get('/public').handler(
  throwing(
    Object.assign(new Error('issuer https://idp.internal down'), {
      statusCode: 502,
      code: 'ERR_IDP',
      publicMessage: 'Sign-in is unavailable',
    }),
  ),
)

const app = createWebApplication()
  .errorHandling(e => e.globalHandlers(GlobalHandler))
  .mount(scoped, plain)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

async function json(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('answerError', () => {
  it("answers with the route's @CatchWith ahead of the group's", async () => {
    expect((await json('/e/route')).body).toEqual({ by: 'route' })
  })

  it("answers with the group's @CatchWith when the route's names nothing for the error", async () => {
    expect((await json('/e/group')).body).toEqual({ by: 'group' })
  })

  it('answers with the global handlers when no scoped handler takes the error', async () => {
    expect((await json('/e/global')).body).toEqual({ by: 'global', name: 'ErrGlobalLevel' })
  })

  // As Fastify's parent handler takes what a group's handler threw.
  it('hands what a scoped handler threw to the global handlers', async () => {
    expect((await json('/e/rethrown')).body).toEqual({ by: 'global', name: 'ErrRethrown' })
  })

  it("sends an ErrHTTP's own body under its status", async () => {
    expect(await json('/p/conflict-body')).toEqual({ status: 409, body: { taken: true } })
  })

  it("keeps the ErrHTTP's status over a Response given as its body", async () => {
    const res = await app.request('/p/forbidden-response')

    expect(res.status).toBe(403)
    expect(await res.text()).toBe('denied')
  })

  it('answers a 4xx error with its message, under the code of its status', async () => {
    const { status, body } = await json('/p/teapot')

    expect(status).toBe(418)
    expect(body).toMatchObject({ code: 'ERR_HTTP_IM_A_TEAPOT', detail: 'short and stout' })
  })

  // The message was written for the log, not for whoever sent the request.
  it('answers a 5xx error with its status alone', async () => {
    const { status, body } = await json('/p/internal')

    expect(status).toBe(500)
    expect(body.code).toBe('ERR_INTERNAL')
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it('answers an error with a public message with that message, never the logged one', async () => {
    const { status, body } = await json('/p/public')

    expect(status).toBe(502)
    expect(body).toMatchObject({ code: 'ERR_IDP', detail: 'Sign-in is unavailable' })
    expect(JSON.stringify(body)).not.toContain('idp.internal')
  })
})

describe('a request that failed its schema', () => {
  @Catch(ErrRequestValidation)
  class ValidationHandler implements ErrorHandler<ErrRequestValidation> {
    handle(_ctx: IContext, err: ErrRequestValidation): ActionResult {
      return { caught: err.slot }
    }
  }

  const failing = new Router('/v').get('/').handler(() => {
    throw new ErrRequestValidation(
      'querystring',
      [
        { message: 'a', path: ['a'], code: 'minLength' },
        { message: 'b', path: ['b'], code: 'maxLength' },
        { message: 'c', path: ['c'], code: 'pattern' },
      ],
      'GET /v',
    )
  })

  it('answers with the validation problem the error handling settings describe, and logs it', async () => {
    const info = vi.fn()
    const validating = createWebApplication()
      .logger(b => b.use({ ...newNoopLogger(), info }))
      .errorHandling(e => e.validation({ type: 'https://example.test/invalid', code: 'BAD', maxErrors: 2 }))
      .mount(failing)
    await validating.bootstrap()

    try {
      const res = await validating.request('/v')

      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        type: 'https://example.test/invalid',
        code: 'BAD',
        detail: 'Invalid query string: showing the first 2 of 3 errors',
        errors: [
          { code: 'ERR_VALIDATION_MIN_LENGTH', detail: 'a a', source: { in: 'query', name: 'a' } },
          { code: 'ERR_VALIDATION_MAX_LENGTH', detail: 'b b', source: { in: 'query', name: 'b' } },
        ],
      })
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ validation: expect.objectContaining({ slot: 'querystring', total: 3 }) }),
        'Invalid query string: 3 errors',
      )
    } finally {
      await validating.close()
    }
  })

  it('is answered by a global handler that catches ErrRequestValidation', async () => {
    const catching = createWebApplication()
      .errorHandling(e => e.globalHandlers(ValidationHandler))
      .mount(failing)
    await catching.bootstrap()

    try {
      expect(await (await catching.request('/v')).json()).toEqual({ caught: 'querystring' })
    } finally {
      await catching.close()
    }
  })
})

// What a client reads back when its request fails a schema, on the Node application.
describe('a request that fails its schema, on the Node application', () => {
  const JSON_BODY = { 'content-type': 'application/json' }
  const JSON_UTF8 = 'application/json; charset=utf-8'
  const STAMPED = { correlation_id: expect.stringMatching(/^req-/), timestamp: expect.any(String) }
  const IMG = '<img src=x onerror=alert(1)>'

  type NodeApp = WebApplication<never, never, unknown, NodeAdapter>
  let served: NodeApp

  function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return served.request(path, { method: 'POST', headers: { ...JSON_BODY, ...headers }, body })
  }

  beforeAll(async () => {
    served = createWebApplication({ adapter: node() }).mount(
      new Router('/slots')
        .post('/body', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/query', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/path/:a', { params: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
        .get('/header', { headers: $t.Object({ 'x-a': $t.Integer() }) }, () => ({ ok: true }))
        .get('/open', { querystring: $t.Object({}, { additionalProperties: $t.Integer() }) }, () => ({ ok: true }))
        .post('/carried', () => {
          throw ErrHTTP.builder()
            .statusCode(422)
            .body({ rejected: true })
            .errors({ code: 'ERR_ITEM_UNAVAILABLE', detail: 'Item 7 is sold out' })
            .build()
        }),
    ) as unknown as NodeApp
    await served.bootstrap()
  })

  afterAll(async () => {
    await served.close()
  })

  // RFC 9110 §15.5.21: the body was understood and its content refused, which is 422. A parameter is part of the
  // request line or its headers, which a request that fails is malformed in: 400.
  it.each([
    [
      'body',
      () => post('/slots/body', '{"a":"x"}'),
      422,
      'Unprocessable Content',
      'Invalid request body',
      'a',
      { in: 'body', pointer: '/a' },
    ],
    [
      'querystring',
      () => served.request('/slots/query?a=x'),
      400,
      'Bad Request',
      'Invalid query string',
      'a',
      { in: 'query', name: 'a' },
    ],
    [
      'params',
      () => served.request('/slots/path/x'),
      400,
      'Bad Request',
      'Invalid path parameters',
      'a',
      { in: 'path', name: 'a' },
    ],
    [
      'headers',
      () => served.request('/slots/header', { headers: { 'x-a': 'x' } }),
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
        errors: [{ code: 'ERR_VALIDATION_TYPE', detail: `${field} Expected integer`, source }],
        ...STAMPED,
      })
    },
  )

  // Each format a client can ask for carries the same entries, and the response says it varies on what it asked.
  it.each([
    ['application/problem+json', 'application/problem+json; charset=utf-8'],
    ['application/json', JSON_UTF8],
    ['*/*', JSON_UTF8],
    [undefined, JSON_UTF8],
  ])('sends the entries to Accept %s', async (accept, contentType) => {
    const res = await post('/slots/body', '{"a":"x"}', accept === undefined ? {} : { accept })

    expect(res.headers.get('content-type')).toBe(contentType)
    expect(res.headers.get('vary')).toBe('Accept')
    expect(((await res.json()) as Problem).errors).toEqual([
      { code: 'ERR_VALIDATION_TYPE', detail: 'a Expected integer', source: { in: 'body', pointer: '/a' } },
    ])
  })

  // A body the error carries is the author's own, whatever entries it was also given.
  it('sends the body an ErrHTTP carries over its entries', async () => {
    const res = await post('/slots/carried', '{}')

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ rejected: true })
  })

  // Returned as JSON, never HTML, and as the exact string sent: escaping is the job of whatever renders it.
  it('returns a key the client chose as written, in JSON', async () => {
    const res = await served.request(`/slots/open?${encodeURIComponent(IMG)}=x`)

    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    expect(((await res.json()) as Problem).errors).toEqual([
      { code: 'ERR_VALIDATION_TYPE', detail: `${IMG} Expected integer`, source: { in: 'query', name: IMG } },
    ])
  })

  // In Markdown a key cannot become HTML, an image or a link with text of its own.
  it.each([
    [
      IMG,
      '- `query <img src=x onerror=alert(1)>` `ERR_VALIDATION_TYPE`: \\<img src=x onerror=alert(1)\\> Expected integer',
    ],
    [
      '[x](https://example.com)',
      '- `query [x](https://example.com)` `ERR_VALIDATION_TYPE`: \\[x\\](https://example.com) Expected integer',
    ],
  ])('escapes a key the client chose in Markdown: %s', async (key, line) => {
    const res = await served.request(`/slots/open?${encodeURIComponent(key)}=x`, {
      headers: { accept: 'text/markdown' },
    })

    expect((await res.text()).split('\n')).toContain(line)
  })

  // Entries are built in arrays: a key the client chose never becomes a property of anything. The engine lists the
  // first rule a request broke.
  it('lists a prototype key as plain data and leaves Object.prototype alone', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()

    const res = await served.request('/slots/open?__proto__=x&constructor=y&prototype=z')

    expect(res.status).toBe(400)
    expect(((await res.json()) as Problem).errors?.map(entry => entry.source)).toEqual([
      { in: 'query', name: '__proto__' },
    ])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
    expect(({} as Record<string, unknown>).x).toBe(undefined)
  })

  // An API that documents its own problem types sends them, on the body's 422 and a parameter's 400 alike.
  it('sends the configured type, title and code for every slot', async () => {
    const configured = {
      type: 'https://api.example.com/problems/validation-error',
      title: 'Request validation failed',
      code: 'ERR_REQUEST_INVALID',
    }
    const typed = createWebApplication({ adapter: node() })
      .errorHandling(e =>
        e.validation({ type: configured.type, title: configured.title }).validation({ code: configured.code }),
      )
      .mount(
        new Router('/typed')
          .post('/', { body: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/q', { querystring: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/p/:a', { params: $t.Object({ a: $t.Integer() }) }, () => ({ ok: true }))
          .get('/h', { headers: $t.Object({ 'x-a': $t.Integer() }) }, () => ({ ok: true })),
      )
    await typed.bootstrap()

    try {
      const answers = await Promise.all([
        typed.request('/typed', { method: 'POST', headers: JSON_BODY, body: '{"a":"x"}' }),
        typed.request('/typed/q?a=x'),
        typed.request('/typed/p/x'),
        typed.request('/typed/h', { headers: { 'x-a': 'x' } }),
      ])
      const problems = (await Promise.all(answers.map(res => res.json()))) as Problem[]

      expect(problems).toEqual([
        expect.objectContaining({ ...configured, status: 422 }),
        expect.objectContaining({ ...configured, status: 400 }),
        expect.objectContaining({ ...configured, status: 400 }),
        expect.objectContaining({ ...configured, status: 400 }),
      ])
    } finally {
      await typed.close()
    }
  })
})
