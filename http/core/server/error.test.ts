import { newNoopLogger } from '@caffeinejs/application/logger'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { Catch } from '../../decorators/index.js'
import type { ActionResult } from '../../response.js'
import type { ErrorHandler } from '../error/handler.js'
import { ErrHTTPConflict, ErrHTTPForbidden } from '../error/http.js'
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
