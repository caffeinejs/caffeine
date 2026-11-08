import { pathToFileURL } from 'node:url'

import {
  $p,
  Args,
  Catch,
  Controller,
  ErrHTTPPreconditionFailed,
  Get,
  Responder,
  type IContext,
  type Router,
  type WebApplication,
} from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, inject, it } from 'vitest'

import { ErrSendFileUnavailable, sendFile, staticFiles, type StaticConfigurer } from '../index.js'

const { fixtures, fixtures2: other, spa } = inject('fixtures')

// Every application in this file routes it; only the ones that install a mount serving `hello.txt` answer it.
@Controller('/guarded')
class GuardedFilesController {
  @Get('/pick')
  @Args([$p.context()])
  pick(ctx: IContext) {
    return sendFile(ctx as never, 'hello.txt')
  }

  @Catch(ErrHTTPPreconditionFailed)
  stale(ctx: IContext) {
    ctx.status(412)
    return { reason: 'The file changed' }
  }
}

void GuardedFilesController

describe('sendFile', () => {
  let app: WebApplication | undefined

  const start = async (configure: StaticConfigurer, routes?: Router<any, any, any, any, any, any>) => {
    app = createWebApplication({}).with(staticFiles(configure)) as WebApplication
    if (routes !== undefined) {
      app.mount(routes)
    }
    await app.bootstrap()

    return app
  }

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('serves a file from a handler', async () => {
    const started = await start(
      s => s.serve(fixtures, { prefix: '/files' }),
      newRouter().get('/pick', ctx => sendFile(ctx, 'hello.txt')),
    )

    const res = await started.request('/pick')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('hello static world\n')
  })

  // The handler answers by returning it, as with any Responder: the value carries the file, nothing else does.
  it('returns a Responder, which the handler returns', async () => {
    let returned: unknown
    const started = await start(
      s => s.serve(fixtures),
      newRouter().get('/pick', ctx => (returned = sendFile(ctx, 'hello.txt'))),
    )

    await started.request('/pick')

    expect(returned).toBeInstanceOf(Responder)
  })

  // It cannot see the gate of the route that called it, so a shared cache never stores what it sends.
  it('marks what it sends private, whatever the mount writes on its own routes', async () => {
    const started = await start(
      s => s.serve(fixtures, { anonymous: true }),
      newRouter().get('/pick', ctx => sendFile(ctx, 'hello.txt')),
    )

    expect((await started.request('/hello.txt')).headers.get('cache-control')).toBe('public, no-cache')
    expect((await started.request('/pick')).headers.get('cache-control')).toBe('private, no-cache')
  })

  it('finds the mount by the root it is given, and takes the first without one', async () => {
    const started = await start(
      s => s.serve(fixtures, { prefix: '/a' }).serve(other, { prefix: '/b' }),
      newRouter()
        .get('/first', ctx => sendFile(ctx, 'hello.txt'))
        .get('/second', ctx => sendFile(ctx, 'other.txt', other))
        .get('/url', ctx => sendFile(ctx, 'other.txt', pathToFileURL(other)))
        .get('/missing', ctx => sendFile(ctx, 'other.txt')),
    )

    expect(await (await started.request('/first')).text()).toBe('hello static world\n')
    expect(await (await started.request('/second')).text()).toBe('second mount file\n')
    expect(await (await started.request('/url')).text()).toBe('second mount file\n')
    // `other.txt` is the second mount's, and the first is asked without a root.
    expect((await started.request('/missing')).status).toBe(404)
  })

  it('sends a file unrouted keeps off the router', async () => {
    const started = await start(
      s => s.serve(fixtures, { unrouted: ['**'] }),
      newRouter().get('/pick', ctx => sendFile(ctx, 'hello.txt')),
    )

    expect((await started.request('/hello.txt')).status).toBe(404)
    expect((await started.request('/pick')).status).toBe(200)
  })

  // A path from a request is looked up in the manifest as it is decoded: nothing resolves `..` against a directory.
  it.each([
    ['/hello.txt', 200],
    ['hello%2Etxt', 200],
    ['/../fixtures/hello.txt', 404],
    ['%2E%2E/hello.txt', 404],
    ['%E0%A4%A.txt', 404],
    ['nope.txt', 404],
  ])('reads %s as a request path, answering %i', async (path, status) => {
    const started = await start(
      s => s.serve(fixtures),
      newRouter().get('/pick', ctx => sendFile(ctx, path)),
    )

    expect((await started.request('/pick')).status).toBe(status)
  })

  it('negotiates the encoding and answers preconditions as a mount route does', async () => {
    const started = await start(
      s => s.serve(spa, { unrouted: ['index.html'] }),
      newRouter().get('/', ctx => sendFile(ctx, 'index.html')),
    )

    const first = await started.request('/', { headers: { 'accept-encoding': 'br' } })
    const etag = first.headers.get('etag')!

    expect(first.headers.get('content-encoding')).toBe('br')
    expect((await started.request('/', { headers: { 'accept-encoding': 'br', 'if-none-match': etag } })).status).toBe(
      304,
    )
  })

  it('keeps a Vary the handler wrote, adding Accept-Encoding', async () => {
    const started = await start(
      s => s.serve(spa, { unrouted: ['index.html'] }),
      newRouter().get('/', ctx => {
        ctx.header('vary', 'Cookie')
        return sendFile(ctx, 'index.html')
      }),
    )

    expect((await started.request('/')).headers.get('vary')).toBe('Cookie, Accept-Encoding')
  })

  it('keeps a status the handler set, with the whole file', async () => {
    const started = await start(
      s => s.serve(fixtures),
      newRouter().get('/gone', ctx => {
        ctx.status(410)
        return sendFile(ctx, 'hello.txt')
      }),
    )

    const res = await started.request('/gone', { headers: { range: 'bytes=0-1' } })

    expect(res.status).toBe(410)
    expect(await res.text()).toBe('hello static world\n')
  })

  it('answers HEAD with the headers of the GET and no body', async () => {
    const started = await start(
      s => s.serve(fixtures),
      newRouter().get('/pick', ctx => sendFile(ctx, 'hello.txt')),
    )

    const res = await started.request('/pick', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('19')
    expect(await res.text()).toBe('')
  })

  // Thrown inside the compiled handler, so a controller's own handler sees the refusal.
  it("reaches a controller's @Catch with a failed precondition", async () => {
    const started = await start(s => s.serve(fixtures))

    const res = await started.request('/guarded/pick', { headers: { 'if-match': '"other"' } })

    expect(res.status).toBe(412)
    expect(await res.json()).toEqual({ reason: 'The file changed' })
  })

  it('names the cause when staticFiles(...) is not installed', async () => {
    let thrown: unknown
    app = createWebApplication({}).mount(
      newRouter().get('/pick', ctx => {
        try {
          return sendFile(ctx, 'hello.txt')
        } catch (err) {
          thrown = err
          throw err
        }
      }),
    ) as WebApplication
    await app.bootstrap()

    expect((await app.request('/pick')).status).toBe(500)
    expect(thrown).toBeInstanceOf(ErrSendFileUnavailable)
    expect((thrown as Error).message.split('\n')[0]).toBe('Cannot send a file: staticFiles(...) is not installed')
  })

  it('names the root no mount serves', async () => {
    let thrown: unknown
    const started = await start(
      s => s.serve(fixtures),
      newRouter().get('/pick', ctx => {
        try {
          return sendFile(ctx, 'other.txt', other)
        } catch (err) {
          thrown = err
          throw err
        }
      }),
    )

    expect((await started.request('/pick')).status).toBe(500)
    expect(thrown).toBeInstanceOf(ErrSendFileUnavailable)
    expect((thrown as ErrSendFileUnavailable).code).toBe('ERR_SEND_FILE_UNAVAILABLE')
    expect((thrown as Error).message.split('\n')[0]).toBe(`Cannot send a file from "${other}": no mount serves it`)
  })
})
