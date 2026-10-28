import { $t } from '@caffeinejs/application/schema'
import { describe, it, expect, vi } from 'vitest'

import {
  Catch,
  CatchWith,
  type IContext,
  Controller,
  ErrHTTP,
  ErrHTTPBadGateway,
  ErrHTTPBadRequest,
  ErrHTTPConflict,
  ErrHTTPFailedDependency,
  ErrHTTPForbidden,
  ErrHTTPGatewayTimeout,
  ErrHTTPGone,
  ErrHTTPImATeapot,
  ErrHTTPInsufficientStorage,
  ErrHTTPInternalServerError,
  ErrHTTPLocked,
  ErrHTTPMethodNotAllowed,
  ErrHTTPMisdirectedRequest,
  ErrHTTPNotAcceptable,
  ErrHTTPNotFound,
  ErrHTTPNotImplemented,
  ErrHTTPPayloadTooLarge,
  ErrHTTPPaymentRequired,
  ErrHTTPPreconditionFailed,
  ErrHTTPProxyAuthenticationRequired,
  ErrHTTPRequestTimeout,
  ErrHTTPServiceUnavailable,
  ErrHTTPTooManyRequests,
  ErrHTTPUnauthorized,
  ErrHTTPUnprocessableEntity,
  ErrHTTPUnsupportedMediaType,
  ErrHTTPVersionNotSupported,
  ErrorHandler,
  Get,
  newHTTPError,
  type Problem,
  Post,
  Schema,
  type ActionResult,
} from '../../index.js'
import { createWebApplication, newRouter } from '../../platform/fastify/index.js'

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
const JSON_UTF8 = 'application/json; charset=utf-8'

// What the framework adds to every problem it sends. The values are pinned where they are what a test is about.
const STAMPED = { correlation_id: expect.stringMatching(/^req-/), timestamp: expect.any(String) }

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
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    // `title` is the status phrase, `detail` the message — the two are not interchangeable.
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'nope',
      code: 'ERR_HTTP_CONFLICT',
      ...STAMPED,
    })

    await app.close()
  })

  // Only a client that asks for the problem media type is told the body is one; a JSON client gets plain JSON.
  it('sends the problem media type to a client that asks for it, and JSON to one that asks for JSON', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const problem = await app.request('/http-err/conflict', { headers: { accept: 'application/problem+json' } })
    const json = await app.request('/http-err/conflict', { headers: { accept: 'application/json' } })

    expect(problem.headers.get('content-type')).toBe(PROBLEM_JSON)
    expect(json.headers.get('content-type')).toBe(JSON_UTF8)

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
      ...STAMPED,
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
      ...STAMPED,
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
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
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
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Internal Server Error',
      code: 'ERR_INTERNAL',
      ...STAMPED,
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
      ...STAMPED,
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
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'body/name must NOT have fewer than 1 characters',
      code: 'FST_ERR_VALIDATION',
      errors: [{ path: 'body.name', message: 'must NOT have fewer than 1 characters', code: 'minLength' }],
      ...STAMPED,
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
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: "Body is not valid JSON but content-type is set to 'application/json'",
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      ...STAMPED,
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
      ...STAMPED,
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

// Every ready-made class says, bare, no more than its status does: a client that switches on `code` or `status`
// gets the same answer whichever of them a handler threw.
describe('ErrHTTP subclasses', () => {
  const classes: Array<[new () => ErrHTTP, number, string]> = [
    [ErrHTTPBadRequest, 400, 'ERR_HTTP_BAD_REQUEST'],
    [ErrHTTPUnauthorized, 401, 'ERR_HTTP_UNAUTHORIZED'],
    [ErrHTTPPaymentRequired, 402, 'ERR_HTTP_PAYMENT_REQUIRED'],
    [ErrHTTPForbidden, 403, 'ERR_HTTP_FORBIDDEN'],
    [ErrHTTPNotFound, 404, 'ERR_HTTP_NOT_FOUND'],
    [ErrHTTPMethodNotAllowed, 405, 'ERR_HTTP_METHOD_NOT_ALLOWED'],
    [ErrHTTPNotAcceptable, 406, 'ERR_HTTP_NOT_ACCEPTABLE'],
    [ErrHTTPProxyAuthenticationRequired, 407, 'ERR_HTTP_PROXY_AUTHENTICATION_REQUIRED'],
    [ErrHTTPRequestTimeout, 408, 'ERR_HTTP_REQUEST_TIMEOUT'],
    [ErrHTTPConflict, 409, 'ERR_HTTP_CONFLICT'],
    [ErrHTTPGone, 410, 'ERR_HTTP_GONE'],
    [ErrHTTPPreconditionFailed, 412, 'ERR_HTTP_PRECONDITION_FAILED'],
    [ErrHTTPPayloadTooLarge, 413, 'ERR_HTTP_PAYLOAD_TOO_LARGE'],
    [ErrHTTPUnsupportedMediaType, 415, 'ERR_HTTP_UNSUPPORTED_MEDIA_TYPE'],
    [ErrHTTPImATeapot, 418, 'ERR_HTTP_IM_A_TEAPOT'],
    [ErrHTTPMisdirectedRequest, 421, 'ERR_HTTP_MISDIRECTED_REQUEST'],
    [ErrHTTPUnprocessableEntity, 422, 'ERR_HTTP_UNPROCESSABLE_ENTITY'],
    [ErrHTTPLocked, 423, 'ERR_HTTP_LOCKED'],
    [ErrHTTPFailedDependency, 424, 'ERR_HTTP_FAILED_DEPENDENCY'],
    [ErrHTTPTooManyRequests, 429, 'ERR_HTTP_TOO_MANY_REQUESTS'],
    [ErrHTTPInternalServerError, 500, 'ERR_HTTP_INTERNAL_SERVER_ERROR'],
    [ErrHTTPNotImplemented, 501, 'ERR_HTTP_NOT_IMPLEMENTED'],
    [ErrHTTPBadGateway, 502, 'ERR_HTTP_BAD_GATEWAY'],
    [ErrHTTPServiceUnavailable, 503, 'ERR_HTTP_SERVICE_UNAVAILABLE'],
    [ErrHTTPGatewayTimeout, 504, 'ERR_HTTP_GATEWAY_TIMEOUT'],
    [ErrHTTPVersionNotSupported, 505, 'ERR_HTTP_VERSION_NOT_SUPPORTED'],
    [ErrHTTPInsufficientStorage, 507, 'ERR_HTTP_INSUFFICIENT_STORAGE'],
  ]

  it('renders each one thrown bare as the problem of its status', async () => {
    const router = newRouter('/thrown')
    for (const [index, [Class]] of classes.entries()) {
      router.get(`/${index}`, () => {
        throw new Class()
      })
    }
    const app = createWebApplication().mount(router)
    await app.bootstrap()

    for (const [index, [Class, status, code]] of classes.entries()) {
      const res = await app.request(`/thrown/${index}`)
      const body = await bodyOf(res)

      expect([Class.name, res.status]).toEqual([Class.name, status])
      expect(new Class().name).toBe(Class.name)
      // The default message is the status phrase, so the detail adds nothing a client did not already know.
      expect(body).toEqual({ type: 'about:blank', title: body.title, status, detail: body.title, code, ...STAMPED })
    }

    await app.close()
  })
})

describe('ErrHTTP.builder', () => {
  // A legacy client keeps its own error shape on one route while the rest of the application speaks problems.
  it('builds an error that sends a body of its own, with its cause and headers', () => {
    const cause = new Error('quota store unreachable')
    const err = ErrHTTP.builder()
      .statusCode(429)
      .message('Slow down')
      .cause(cause)
      .headers({ 'retry-after': '30' })
      .body({ error: 'rate_limited' })
      .options({ code: 'ERR_RATE_LIMITED' })
      .build()

    expect(err).toBeInstanceOf(ErrHTTP)
    expect([err.statusCode, err.message, err.code]).toEqual([429, 'Slow down', 'ERR_RATE_LIMITED'])
    expect(err.cause).toBe(cause)
    expect(err.headers).toEqual({ 'retry-after': '30' })
    expect(err.body).toEqual({ error: 'rate_limited' })
  })

  // `options(...)` merges over what the fluent calls set, so a shared default block and a per-site detail compose.
  it('keeps the fields options() does not name', () => {
    const err = newHTTPError()
      .statusCode(404)
      .message('Pet 42 not found')
      .type('https://example.com/problems/pet-not-found')
      .options({ instance: '/pets/42' })
      .build()

    expect(err.toProblem()).toEqual({
      type: 'https://example.com/problems/pet-not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Pet 42 not found',
      code: 'ERR_HTTP',
      instance: '/pets/42',
    })
  })
})

class ErrInventory extends Error {}

@Catch(ErrInventory)
class InventoryHandler implements ErrorHandler<ErrInventory> {
  handle(ctx: IContext): ActionResult {
    ctx.status(409)
    return { inventory: 'conflict' }
  }
}
void [InventoryHandler]

// A controller with handlers of its own still falls back to the application's problem for everything else.
@CatchWith(InventoryHandler)
@Controller('/inventory')
class InventoryController {
  @Get('/legacy')
  legacy(): ActionResult {
    // Some older libraries reject with a string rather than an Error.
    throw 'connection reset by peer' as unknown as Error
  }
}
void [InventoryController]

describe('failures from the real world', () => {
  it('answers a thrown string with the generic problem, from a plain route and from a controller with handlers', async () => {
    const app = createWebApplication().mount(
      newRouter('/legacy').get('/', () => {
        throw 'socket hang up' as unknown as Error
      }),
    )
    await app.bootstrap()

    for (const path of ['/legacy', '/inventory/legacy']) {
      const res = await app.request(path)
      const text = await res.text()

      expect(res.status).toBe(500)
      expect(res.headers.get('content-type')).toBe(JSON_UTF8)
      expect(JSON.parse(text)).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Internal Server Error',
        code: 'ERR_INTERNAL',
        ...STAMPED,
      })
      expect(text).not.toMatch(/hang up|reset by peer/)
    }

    await app.close()
  })

  // What a rate limiter throws: a 429 that tells the client when to come back.
  it('keeps the headers a 4xx from a library carries, beside the problem', async () => {
    const app = createWebApplication().mount(
      newRouter('/search').get('/', () => {
        throw Object.assign(new Error('Rate limit exceeded, retry in 30 seconds'), {
          statusCode: 429,
          code: 'FST_ERR_RATE_LIMIT',
          headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0' },
        })
      }),
    )
    await app.bootstrap()

    const res = await app.request('/search')

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Rate limit exceeded, retry in 30 seconds',
      code: 'FST_ERR_RATE_LIMIT',
      ...STAMPED,
    })

    await app.close()
  })

  // nginx's 499: a status with no phrase still gets a code a client can look up.
  it('names a status Node has no phrase for', async () => {
    const app = createWebApplication().mount(
      newRouter('/upload').get('/', () => {
        throw Object.assign(new Error('Client closed the request'), { statusCode: 499 })
      }),
    )
    await app.bootstrap()

    const res = await app.request('/upload')

    expect(res.status).toBe(499)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Unknown Error',
      status: 499,
      detail: 'Client closed the request',
      code: 'ERR_HTTP',
      ...STAMPED,
    })

    await app.close()
  })

  // A webhook handler that checks its payload with its own Ajv instance and throws what Ajv reported, the way
  // Fastify does. Ajv built with `messages: false` leaves each message out, and there is no request slot to name.
  it('lists the issues of a validation a handler ran itself', async () => {
    const app = createWebApplication().mount(
      newRouter('/webhooks').post('/', () => {
        throw Object.assign(new Error('Webhook payload is invalid'), {
          statusCode: 422,
          code: 'ERR_WEBHOOK_PAYLOAD',
          validation: [
            { keyword: 'required', instancePath: '/data', schemaPath: '#/required', params: { missingProperty: 'id' } },
            {
              keyword: 'enum',
              instancePath: '/event/a~1b~0c',
              schemaPath: '#/enum',
              params: {},
              message: 'must be equal to one of the allowed values',
            },
          ],
        })
      }),
    )
    await app.bootstrap()

    const res = await app.request('/webhooks', { method: 'POST' })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'Webhook payload is invalid',
      code: 'ERR_WEBHOOK_PAYLOAD',
      // JSON pointer escapes are undone: `~1` is a slash and `~0` a tilde inside one property name.
      errors: [
        { path: 'data.id', message: 'is invalid', code: 'required' },
        { path: 'event.a/b~c', message: 'must be equal to one of the allowed values', code: 'enum' },
      ],
      ...STAMPED,
    })

    await app.close()
  })

  // An error rebuilt from a worker or an RPC reply often has no stack of its own; its name and message still say
  // what failed.
  // A sign-in callback whose state does not match: the caller's mistake, said in words written for them, while the
  // detail that names the provider stays in the log, recorded as information rather than as a fault.
  it('answers a 4xx naming a public message with that message, and logs it as information', async () => {
    const logged: LogEntry[] = []
    const app = loggingTo(logged).mount(
      newRouter('/auth').get('/callback', () => {
        throw Object.assign(new Error('state abc did not match the one sent to https://idp.internal'), {
          statusCode: 400,
          code: 'ERR_OIDC_STATE',
          publicMessage: 'The sign-in link is no longer valid',
        })
      }),
    )
    await app.bootstrap()

    const res = await app.request('/auth/callback')
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The sign-in link is no longer valid',
      code: 'ERR_OIDC_STATE',
      ...STAMPED,
    })
    expect(text).not.toContain('idp.internal')
    const entries = logged.filter(entry => entry.msg?.includes('did not match'))
    expect(entries.map(entry => entry.level)).toEqual([30])

    await app.close()
  })

  it('names a cause that has no stack in the stack trace it exposes', async () => {
    const remote = Object.assign(Object.create(Error.prototype) as Error, {
      name: 'ErrLedger',
      message: 'ledger shard 3 is read-only',
    })
    const app = createWebApplication()
      .errorHandling(e => e.exposeStacktrace())
      .mount(
        newRouter('/payments').post('/', () => {
          throw new Error('Cannot record the payment', { cause: remote })
        }),
      )
    await app.bootstrap()

    const body = await bodyOf(await app.request('/payments', { method: 'POST' }))

    expect(body.stacktrace).toContain('Caused by: ErrLedger: ledger shard 3 is read-only')

    await app.close()
  })
})

// A route that declares its error statuses in its schema, with the shape it answered with before problems, or
// with a narrower one. The schema describes what a handler returns; the problem the framework renders is its own.
describe('a route that declares an error response schema', () => {
  const legacy = $t.Object({ code: $t.String(), message: $t.String() })

  function orders() {
    return newRouter('/orders')
      .get('/:id', { response: { 200: $t.Object({ id: $t.String() }), 404: legacy } }, () => {
        throw new ErrHTTPNotFound('Order 42 not found')
      })
      .get('/', { querystring: $t.Object({ limit: $t.Integer() }), response: { 400: legacy } }, () => [])
      .get('/narrow/:id', { response: { 404: $t.Object({ detail: $t.String() }) } }, () => {
        throw new ErrHTTPNotFound('Order 42 not found')
      })
      .get('/helper/:id', { response: { 404: legacy } }, ctx => {
        ctx.notFound()
      })
  }

  it('still answers a thrown error with its status and the whole problem', async () => {
    const app = createWebApplication().mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders/42')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe(JSON_UTF8)
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Order 42 not found',
      code: 'ERR_HTTP_NOT_FOUND',
      ...STAMPED,
    })

    await app.close()
  })

  it('still answers a failed validation with 400 and the issues', async () => {
    const app = createWebApplication().mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders?limit=many')

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      status: 400,
      code: 'FST_ERR_VALIDATION',
      errors: [{ path: 'querystring.limit', message: 'must be integer', code: 'type' }],
    })

    await app.close()
  })

  // A schema the problem happens to satisfy would otherwise keep only what it declares.
  it('keeps every member a narrower schema leaves out', async () => {
    const app = createWebApplication().mount(orders())
    await app.bootstrap()

    const problem = (await (await app.request('/orders/narrow/42')).json()) as Record<string, unknown>

    expect(Object.keys(problem).sort()).toEqual([
      'code',
      'correlation_id',
      'detail',
      'status',
      'timestamp',
      'title',
      'type',
    ])

    await app.close()
  })

  it('answers a ctx helper without a body with the problem', async () => {
    const app = createWebApplication().mount(orders())
    await app.bootstrap()

    const res = await app.request('/orders/helper/42')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ status: 404, code: 'ERR_HTTP_NOT_FOUND' })

    await app.close()
  })
})

describe('the members an agent acts on', () => {
  function checkout() {
    return newRouter('/checkout')
      .post('/', () => {
        throw ErrHTTP.builder()
          .statusCode(429)
          .message('12 payment attempts in the last minute')
          .code('ERR_PAYMENT_RATE_LIMITED')
          .category('rate_limit')
          .whatYouShouldDo('Wait for the Retry-After seconds, then retry once. Do not retry in a loop.')
          .headers({ 'retry-after': '30' })
          .build()
      })
      .post('/coupon', () => {
        throw new ErrHTTPUnprocessableEntity('Coupon SPRING expired on 2026-04-01', {
          category: 'validation',
          whatYouShouldDo: 'Remove the coupon and submit the order again.',
        })
      })
      .get('/plain', () => {
        throw new ErrHTTPNotFound('No checkout session')
      })
  }

  // An agent paying for an order hits a rate limit: it branches on the category and follows the guidance, with
  // no prose to interpret, and quotes the correlation ID if it has to escalate.
  it('tells an agent asking for Markdown what failed, what to do and how to quote it', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .mount(checkout())
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T15:30:00.000Z'))

    try {
      const res = await app.request('/checkout', {
        method: 'POST',
        headers: { accept: 'text/markdown', 'x-request-id': 'chk-81' },
      })

      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe('30')
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(await res.text()).toBe(
        [
          '---',
          'type: "about:blank"',
          'title: "Too Many Requests"',
          'status: 429',
          'code: "ERR_PAYMENT_RATE_LIMITED"',
          'category: "rate_limit"',
          'correlation_id: "chk-81"',
          'timestamp: "2026-10-28T15:30:00.000Z"',
          '---',
          '',
          '# Too Many Requests',
          '',
          '## What happened',
          '',
          '12 payment attempts in the last minute',
          '',
          '## What you should do',
          '',
          'Wait for the Retry-After seconds, then retry once. Do not retry in a loop.',
          '',
        ].join('\n'),
      )
    } finally {
      vi.useRealTimers()
      await app.close()
    }
  })

  // The same members in JSON, set through the options a subclass takes.
  it('sends the category and the guidance an error was given in its options', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .mount(checkout())
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T15:30:00.000Z'))

    try {
      const res = await app.request('/checkout/coupon', {
        method: 'POST',
        headers: { accept: 'application/problem+json', 'x-request-id': 'chk-82' },
      })

      expect(res.headers.get('content-type')).toBe(PROBLEM_JSON)
      expect(await res.json()).toEqual({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Coupon SPRING expired on 2026-04-01',
        code: 'ERR_HTTP_UNPROCESSABLE_ENTITY',
        category: 'validation',
        what_you_should_do: 'Remove the coupon and submit the order again.',
        correlation_id: 'chk-82',
        timestamp: '2026-10-28T15:30:00.000Z',
      })
    } finally {
      vi.useRealTimers()
      await app.close()
    }
  })

  // Guidance is written by someone who knows the fix. A guess from the framework would mislead an agent.
  it('leaves the category and the guidance out unless the error was given them', async () => {
    const app = createWebApplication().mount(checkout())
    await app.bootstrap()

    const problem = await bodyOf(await app.request('/checkout/plain'))

    expect(Object.keys(problem).sort()).toEqual([
      'code',
      'correlation_id',
      'detail',
      'status',
      'timestamp',
      'title',
      'type',
    ])
    // Rendered now, in UTC, to the millisecond.
    expect(problem.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    await app.close()
  })

  // The members describe the error, so the problem a @Catch handler builds from it carries them too.
  it('puts the category and the guidance on the problem toProblem() builds', () => {
    const err = newHTTPError()
      .statusCode(503)
      .message('The ledger is read-only during the nightly close')
      .category('maintenance')
      .whatYouShouldDo('Retry after 02:00 UTC.')
      .build()

    expect(err.toProblem()).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The ledger is read-only during the nightly close',
      code: 'ERR_HTTP',
      category: 'maintenance',
      what_you_should_do: 'Retry after 02:00 UTC.',
    })
  })
})
