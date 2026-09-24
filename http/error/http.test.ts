import { $t } from '@caffeinejs/std/schema'
import { describe, it, expect } from 'vitest'

import {
  Catch,
  type Context,
  Controller,
  ErrHTTPBadRequest,
  ErrHTTPConflict,
  ErrorHandler,
  Get,
  type HTTPErrorBody,
  Post,
  Schema,
  createWebApplication,
} from '../index.js'

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

async function bodyOf(response: Response): Promise<HTTPErrorBody> {
  return (await response.json()) as HTTPErrorBody
}

@Controller('/http-err')
class HTTPErrController {
  @Get('/conflict')
  conflict(): unknown {
    throw new ErrHTTPConflict('nope')
  }

  @Get('/zero-body')
  zero(): unknown {
    throw new ErrHTTPBadRequest('bad', { body: 0 })
  }

  @Get('/with-headers')
  headers(): unknown {
    throw new ErrHTTPBadRequest('bad', { headers: { 'x-detail': 'why' } })
  }
}
void [HTTPErrController]

@Controller('/unexpected')
class UnexpectedController {
  @Get('/boom')
  boom(): unknown {
    throw new Error('relation "customers" does not exist')
  }

  @Get('/wrapped')
  wrapped(): unknown {
    throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.7:8443') })
  }

  @Get('/unavailable')
  unavailable(): unknown {
    throw Object.assign(new Error('pool exhausted at 10.0.0.5:5432'), { statusCode: 503 })
  }

  @Get('/upstream')
  upstream(): unknown {
    throw Object.assign(new Error('issuer https://idp.internal did not answer'), {
      statusCode: 502,
      code: 'ERR_UPSTREAM',
      publicMessage: 'Upstream is unavailable',
    })
  }

  @Post('/validated')
  @Schema({ body: $t.Object({ name: $t.String({ minLength: 1 }) }) })
  validated(): unknown {
    return { ok: true }
  }
}
void [UnexpectedController]

// Declared in the same module as the tests that assert the default envelope, and deliberately so: a handler
// class nobody enrols renders nothing, so it cannot reach the applications built below.
@Catch(ErrHTTPConflict)
class NeverEnrolledHandler implements ErrorHandler<ErrHTTPConflict> {
  async handle(ctx: Context, _error: ErrHTTPConflict): Promise<void> {
    ctx.status(418).body({ enrolled: true })
  }
}
void [NeverEnrolledHandler]

describe('ErrHTTP envelope fallback', () => {
  it('renders the status and a structured envelope for an unhandled ErrHTTP', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(409)
    // `error` is the status phrase, `message` the detail — the two are not interchangeable.
    expect(await res.json()).toEqual({
      error: 'Conflict',
      code: 'ERR_HTTP_CONFLICT',
      statusCode: 409,
      message: 'nope',
    })

    await app.close()
  })

  it('sends a falsy-but-defined body verbatim instead of the envelope', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/zero-body')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('0')

    await app.close()
  })

  // `headers` is optional and stays undefined when the error carries none, so this is the only path that
  // reaches reply.headers at all.
  it('applies the headers an ErrHTTP carries', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/with-headers')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-detail')).toBe('why')

    await app.close()
  })

  // The envelope is what an application gets for free. A @Catch class declared anywhere in the process used to
  // replace it by being imported; now only the application naming the handler does.
  it('keeps the envelope when a matching handler was declared but never enrolled', async () => {
    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ERR_HTTP_CONFLICT' })

    await app.close()
  })

  it('replaces the envelope once the application enrols that same handler', async () => {
    const app = createWebApplication().errorHandling(e => e.globalHandlers(NeverEnrolledHandler))
    await app.ready()

    const res = await app.fetch('/http-err/conflict')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ enrolled: true })

    await app.close()
  })
})

// An error the application did not anticipate says nothing to the caller. Everything it does say — a table
// name, a driver code, the address of a service that did not answer — is written for whoever reads the log.
describe('an unexpected failure', () => {
  it('answers a generic 500 and keeps the detail in the log', async () => {
    const logged: LogEntry[] = []
    const app = loggingTo(logged)
    await app.ready()

    const res = await app.fetch('/unexpected/boom')
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'ERR_INTERNAL',
      message: 'Internal Server Error',
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
    await app.ready()

    const res = await app.fetch('/unexpected/unavailable')
    const text = await res.text()

    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'ERR_INTERNAL',
      message: 'Service Unavailable',
    })
    expect(text).not.toContain('10.0.0.5')

    await app.close()
  })

  // A 4xx describes what the caller got wrong, so Fastify's own rendering is what answers — and a request
  // somebody got wrong is not a fault for an operator to be paged about.
  it('leaves a 4xx alone, with its field detail, and logs it as information', async () => {
    const logged: LogEntry[] = []
    const app = loggingTo(logged)
    await app.ready()

    const res = await app.fetch('/unexpected/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    const body = await bodyOf(res)

    expect(res.status).toBe(400)
    expect(body.message).toContain('name')

    const entries = logged.filter(entry => entry.msg?.includes('name'))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every(entry => entry.level === 30)).toBe(true)

    await app.close()
  })
})

describe('exposeStacktrace', () => {
  it('adds the stack while the message stays generic', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.ready()

    const body = await bodyOf(await app.fetch('/unexpected/boom'))

    // The envelope a client parses does not change shape with a server setting.
    expect(body.message).toBe('Internal Server Error')
    expect(body.stacktrace).toContain('relation "customers" does not exist')
    expect(body.stacktrace).toContain('at ')

    await app.close()
  })

  // A rejected fetch says only "fetch failed" until its cause names the address.
  it('includes the chain of causes behind the error', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.ready()

    const body = await bodyOf(await app.fetch('/unexpected/wrapped'))

    expect(body.stacktrace).toContain('fetch failed')
    expect(body.stacktrace).toContain('Caused by:')
    expect(body.stacktrace).toContain('connect ECONNREFUSED 10.0.0.7:8443')

    await app.close()
  })

  it('adds it to a thrown ErrHTTP and to an error naming a public message', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.ready()

    const conflict = await bodyOf(await app.fetch('/http-err/conflict'))
    expect(conflict.message).toBe('nope')
    expect(conflict.stacktrace).toContain('ErrHTTPConflict')

    const upstream = await bodyOf(await app.fetch('/unexpected/upstream'))
    expect(upstream.message).toBe('Upstream is unavailable')
    expect(upstream.stacktrace).toContain('idp.internal')

    await app.close()
  })

  // A body the error carried is the author's own and need not be an object, so there is nothing to add to.
  it('leaves a body the error carried verbatim', async () => {
    const app = createWebApplication().errorHandling(e => e.exposeStacktrace())
    await app.ready()

    expect(await (await app.fetch('/http-err/zero-body')).text()).toBe('0')

    await app.close()
  })

  it('is off unless the application asks for it', async () => {
    const app = createWebApplication()
    await app.ready()

    expect((await bodyOf(await app.fetch('/unexpected/boom'))).stacktrace).toBeUndefined()
    expect((await bodyOf(await app.fetch('/http-err/conflict'))).stacktrace).toBeUndefined()
    expect((await bodyOf(await app.fetch('/unexpected/upstream'))).stacktrace).toBeUndefined()

    await app.close()
  })
})
