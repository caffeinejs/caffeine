import { describe, expect, it } from 'vitest'

import { ErrCaffeineWebApplication } from '../../../core/error/common.js'
import { ErrHTTPUnauthorized } from '../../../core/error/http.js'
import { Catch, type ErrorHandler, type IContext } from '../../../index.js'
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
