import { $t } from '@caffeinejs/application/schema'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  type IContext,
  Controller,
  ErrHTTP,
  ErrHTTPBadRequest,
  ErrHTTPConflict,
  ErrHTTPUnauthorized,
  ErrorHandler,
  Get,
  type Problem,
  Post,
  Schema,
  type ActionResult,
} from '../../index.js'
import { createWebApplication } from '../../platform/fastify/index.js'

interface LogEntry {
  level?: number
  msg?: string
}

/** Fastify's own logger, writing every line into `logged`. Named in the factory settings, so it is the server's. */
function pinoTo(logged: LogEntry[], level = 'info') {
  return { level, stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } }
}

function loggingTo(logged: LogEntry[]) {
  return createWebApplication().server(() => ({ factory: { logger: pinoTo(logged) } }))
}

async function bodyOf(response: Response): Promise<Problem> {
  return (await response.json()) as Problem
}

const PROBLEM_JSON = 'application/problem+json; charset=utf-8'

@Controller('/http-err')
class HTTPErrController {
  @Get('/conflict')
  conflict(): ActionResult {
    throw new ErrHTTPConflict('nope')
  }

  @Get('/zero-body')
  zero(): ActionResult {
    throw new ErrHTTPBadRequest('bad', { body: 0 })
  }

  @Get('/with-headers')
  headers(): ActionResult {
    throw new ErrHTTPBadRequest('bad', { headers: { 'x-detail': 'why' } })
  }

  @Get('/typed')
  typed(): ActionResult {
    throw ErrHTTP.builder()
      .statusCode(409)
      .message('Order 42 is already paid')
      .code('ERR_ORDER_PAID')
      .type('https://example.com/problems/order-paid')
      .instance('/orders/42')
      .extension('orderID', '42')
      .extensions({ balance: 0 })
      .build()
  }

  @Get('/forged')
  forged(): ActionResult {
    throw new ErrHTTPConflict('nope', { extensions: { status: 200, title: 'OK', stacktrace: 'forged', retry: false } })
  }

  @Get('/typed-body')
  typedBody(): ActionResult {
    throw new ErrHTTPConflict('nope', {
      body: { mine: true },
      type: 'https://example.com/problems/conflict',
      instance: '/orders/42',
      extensions: { orderID: '42' },
    })
  }

  @Get('/challenge')
  challenge(): ActionResult {
    throw new ErrHTTPUnauthorized('Sign in first', { headers: { 'www-authenticate': 'Bearer realm="api"' } })
  }
}
void [HTTPErrController]

@Controller('/unexpected')
class UnexpectedController {
  @Get('/boom')
  boom(): ActionResult {
    throw new Error('relation "customers" does not exist')
  }

  @Get('/wrapped')
  wrapped(): ActionResult {
    throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.7:8443') })
  }

  @Get('/unavailable')
  unavailable(): ActionResult {
    throw Object.assign(new Error('pool exhausted at 10.0.0.5:5432'), { statusCode: 503 })
  }

  @Get('/upstream')
  upstream(): ActionResult {
    throw Object.assign(new Error('issuer https://idp.internal did not answer'), {
      statusCode: 502,
      code: 'ERR_UPSTREAM',
      publicMessage: 'Upstream is unavailable',
    })
  }

  @Get('/teapot')
  teapot(): ActionResult {
    throw Object.assign(new Error('short and stout'), { statusCode: 418 })
  }

  @Post('/validated')
  @Schema({ body: $t.Object({ name: $t.String({ minLength: 1 }) }) })
  validated(): ActionResult {
    return { ok: true }
  }
}
void [UnexpectedController]

// Declared in the same module as the tests that assert the default problem, and deliberately so: a handler
// class nobody enrols renders nothing, so it cannot reach the applications built below.
@Catch(ErrHTTPConflict)
class NeverEnrolledHandler implements ErrorHandler<ErrHTTPConflict> {
  async handle(ctx: IContext, _error: ErrHTTPConflict): Promise<void> {
    ctx.status(418).body({ enrolled: true })
  }
}
void [NeverEnrolledHandler]

describe('ErrHTTP problem fallback', () => {
  it('renders an unhandled ErrHTTP as an RFC 9457 problem', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    // `title` is the status phrase, `detail` the message — the two are not interchangeable.
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'nope',
      code: 'ERR_HTTP_CONFLICT',
    })

    await app.close()
  })

  // A client that only asked for JSON still gets the problem media type: it is JSON, and it says what it is.
  it('sends the problem media type when the request accepts application/json', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/conflict', { headers: { accept: 'application/json' } })

    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)

    await app.close()
  })

  it('sends the type, instance and extensions the error carries', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/typed')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      type: 'https://example.com/problems/order-paid',
      title: 'Conflict',
      status: 409,
      detail: 'Order 42 is already paid',
      code: 'ERR_ORDER_PAID',
      instance: '/orders/42',
      orderID: '42',
      balance: 0,
    })

    await app.close()
  })

  // An extension cannot change what the status line says, nor slip a stack trace past `exposeStacktrace`.
  it('drops an extension named like a member the problem defines', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/forged')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'nope',
      code: 'ERR_HTTP_CONFLICT',
      retry: false,
    })

    await app.close()
  })

  // A body the error carried is the author's: it keeps its media type, and none of the problem's fields join it.
  it('sends a body the error carried as it stands, without the problem fields or media type', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/typed-body')

    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ mine: true })

    await app.close()
  })

  // The body does not stand in for a challenge: a client that authenticates reads `WWW-Authenticate`.
  it('keeps the headers an ErrHTTP carries beside the problem', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/challenge')

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="api"')
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(await res.json()).toMatchObject({ status: 401, detail: 'Sign in first', code: 'ERR_HTTP_UNAUTHORIZED' })

    await app.close()
  })

  it('sends a falsy-but-defined body verbatim instead of the problem', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/zero-body')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('0')

    await app.close()
  })

  // `headers` is optional and stays undefined when the error carries none, so this is the only path that
  // reaches reply.headers at all.
  it('applies the headers an ErrHTTP carries', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/with-headers')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-detail')).toBe('why')

    await app.close()
  })

  // The problem is what an application gets for free. A @Catch class declared anywhere in the process used to
  // replace it by being imported; now only the application naming the handler does.
  it('keeps the problem when a matching handler was declared but never enrolled', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ERR_HTTP_CONFLICT' })

    await app.close()
  })

  it('replaces the problem once the application enrols that same handler', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(NeverEnrolledHandler))
    await app.bootstrap()

    const res = await app.request('/http-err/conflict')

    expect(res.status).toBe(418)
    // What a handler answers is its own: the framework does not relabel an object as a problem.
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ enrolled: true })

    await app.close()
  })
})

// A handler that keeps the problem contract states the media type itself: the framework never guesses it.
@Catch(ErrHTTPConflict)
class ProblemHandler implements ErrorHandler<ErrHTTPConflict> {
  handle(ctx: IContext, err: ErrHTTPConflict): ActionResult {
    ctx.status(err.statusCode).header('content-type', 'application/problem+json')
    return { ...err.toProblem(), handledBy: 'ProblemHandler' }
  }
}
void [ProblemHandler]

describe('ErrHTTP.toProblem', () => {
  it('lets a @Catch handler answer with the problem under the media type it sets', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(ProblemHandler))
    await app.bootstrap()

    const res = await app.request('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'nope',
      code: 'ERR_HTTP_CONFLICT',
      handledBy: 'ProblemHandler',
    })

    await app.close()
  })

  // What a @Catch handler returns to keep the contract while it adds something of its own, such as a log line.
  it('renders the same problem the error handler sends', () => {
    const err = new ErrHTTPConflict('nope', { type: 'https://example.com/problems/conflict', instance: '/orders/42' })

    expect(err.toProblem()).toEqual({
      type: 'https://example.com/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'nope',
      code: 'ERR_HTTP_CONFLICT',
      instance: '/orders/42',
    })
  })
})

// An error the application did not anticipate says nothing to the caller. Everything it does say — a table
// name, a driver code, the address of a service that did not answer — is written for whoever reads the log.
describe('an unexpected failure', () => {
  it('answers a generic 500 and keeps the detail in the log', async () => {
    const logged: LogEntry[] = []
    const app = loggingTo(logged)
    await app.bootstrap()

    const res = await app.request('/unexpected/boom')
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Internal Server Error',
      code: 'ERR_INTERNAL',
    })
    // The name of the table a statement failed on is the caller's business in no deployment.
    expect(text).not.toContain('customers')

    // On record for whoever looks, as a fault (pino: 30 is info, 50 is error).
    const entries = logged.filter(entry => entry.msg?.includes('relation "customers" does not exist'))
    expect(entries.map(entry => entry.level)).toEqual([50])

    await app.close()
  })

  // The status says how to react — retry, or do not. Only the message disclosed anything.
  it('keeps the status the error asked for rather than collapsing it to 500', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/unexpected/unavailable')
    const text = await res.text()

    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Service Unavailable',
      code: 'ERR_INTERNAL',
    })
    expect(text).not.toContain('10.0.0.5')

    await app.close()
  })

  // A 4xx describes what the caller got wrong, so its message is the detail and each failed rule is listed — and a
  // request somebody got wrong is not a fault for an operator to be paged about.
  it('renders a schema failure as a problem listing each failed rule, and logs it as information', async () => {
    const logged: LogEntry[] = []
    const app = loggingTo(logged)
    await app.bootstrap()

    const res = await app.request('/unexpected/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'body/name must NOT have fewer than 1 characters',
      code: 'FST_ERR_VALIDATION',
      errors: [{ path: 'body.name', message: 'must NOT have fewer than 1 characters', code: 'minLength' }],
    })

    const entries = logged.filter(entry => entry.msg === 'body/name must NOT have fewer than 1 characters')
    expect(entries.map(entry => entry.level)).toEqual([30])

    await app.close()
  })

  // Ajv reports a missing property at the object that lacks it; the path names the property itself.
  it('names a missing property in its path', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/unexpected/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect((await bodyOf(res)).errors).toEqual([
      { path: 'body.name', message: "must have required property 'name'", code: 'required' },
    ])

    await app.close()
  })

  // Fastify refuses a body it cannot parse before any handler runs; its code is what a client can look up.
  it('renders a request Fastify refused as a problem with its own code', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/unexpected/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: "Body is not valid JSON but content-type is set to 'application/json'",
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    })

    await app.close()
  })

  it('names the status in the code of a 4xx that carries none', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/unexpected/teapot')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: "I'm a Teapot",
      status: 418,
      detail: 'short and stout',
      code: 'ERR_HTTP_IM_A_TEAPOT',
    })

    await app.close()
  })
})

describe('exposeStacktrace', () => {
  it('adds the stack while the message stays generic', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.bootstrap()

    const body = await bodyOf(await app.request('/unexpected/boom'))

    // The problem a client parses does not change shape with a server setting.
    expect(body.detail).toBe('Internal Server Error')
    expect(body.stacktrace).toContain('relation "customers" does not exist')
    expect(body.stacktrace).toContain('at ')

    await app.close()
  })

  // A rejected fetch says only "fetch failed" until its cause names the address.
  it('includes the chain of causes behind the error', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.bootstrap()

    const body = await bodyOf(await app.request('/unexpected/wrapped'))

    expect(body.stacktrace).toContain('fetch failed')
    expect(body.stacktrace).toContain('Caused by:')
    expect(body.stacktrace).toContain('connect ECONNREFUSED 10.0.0.7:8443')

    await app.close()
  })

  it('adds it to a thrown ErrHTTP and to an error naming a public message', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.bootstrap()

    const conflict = await bodyOf(await app.request('/http-err/conflict'))
    expect(conflict.detail).toBe('nope')
    expect(conflict.stacktrace).toContain('ErrHTTPConflict')

    const upstream = await bodyOf(await app.request('/unexpected/upstream'))
    expect(upstream.detail).toBe('Upstream is unavailable')
    expect(upstream.stacktrace).toContain('idp.internal')

    await app.close()
  })

  // A body the error carried is the author's own and need not be an object, so there is nothing to add to.
  it('leaves a body the error carried verbatim', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.bootstrap()

    expect(await (await app.request('/http-err/zero-body')).text()).toBe('0')

    await app.close()
  })

  it('is off unless the application asks for it', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    expect((await bodyOf(await app.request('/unexpected/boom'))).stacktrace).toBeUndefined()
    expect((await bodyOf(await app.request('/http-err/conflict'))).stacktrace).toBeUndefined()
    expect((await bodyOf(await app.request('/unexpected/upstream'))).stacktrace).toBeUndefined()

    await app.close()
  })
})
