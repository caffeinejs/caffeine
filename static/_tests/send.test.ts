import { fileURLToPath } from 'node:url'

import { createWebApplication, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { download, sendFile, staticFiles, type StaticConfigurer } from '../index.js'

const fixtures = fileURLToPath(new URL('./_testdata/fixtures', import.meta.url))
const other = fileURLToPath(new URL('./_testdata/fixtures2', import.meta.url))

describe('sendFile and download', () => {
  let app: WebApplication | undefined

  const start = async (configure: StaticConfigurer) => {
    const routes = newRouter()
      .get('/pick', ctx => sendFile(ctx, 'hello.txt'))
      .get('/grab', ctx => download(ctx, 'hello.txt', 'greeting.txt', { root: fixtures }))
      .get('/elsewhere', ctx => sendFile(ctx, 'other.txt'))

    app = createWebApplication({}).with(staticFiles(configure)).mount(routes) as WebApplication
    await app.ready()

    return app
  }

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('serves a file from a handler', async () => {
    const started = await start(s => s.serve(fixtures, { prefix: '/files' }))

    const res = await started.fetch('/pick')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain('hello static world')
  })

  // The decorator pumps the file without awaiting, so the context does not yet know it answered. A handler
  // that drops the return value lets the adapter send an empty body over it: the caller sees a 200 with
  // nothing in it, and only the server log carries Fastify's "did you forget to return reply" warning.
  it('needs the handler to return what it returns', async () => {
    app = createWebApplication({})
      .with(staticFiles(s => s.serve(fixtures, { prefix: '/files' })))
      .mount(
        newRouter().get('/dropped', ctx => {
          sendFile(ctx, 'hello.txt')
        }),
      ) as WebApplication
    await app.ready()

    const res = await app.fetch('/dropped')

    expect(await res.text()).toBe('')
  })

  // `@fastify/static`'s `download` does not fall back to the mount root the way its `sendFile` does, so a
  // relative path needs `root`. Pinned here because the failure is a bare 404 that names nothing.
  it('sends a download as an attachment under the name given', async () => {
    const started = await start(s => s.serve(fixtures, { prefix: '/files' }))

    const res = await started.fetch('/grab')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('content-disposition')).toContain('greeting.txt')
    expect(await res.text()).toContain('hello static world')
  })

  // A single-mount application still has the decoration, so the helpers work with no second `.serve(...)`.
  it('decorates from the only mount', async () => {
    const started = await start(s => s.serve(fixtures))

    expect((await started.fetch('/pick')).status).toBe(200)
  })

  it('lets a later mount take the decoration when it asks for it', async () => {
    const started = await start(s =>
      s.serve(fixtures, { prefix: '/a' }).serve(other, { prefix: '/b', decorateReply: true }),
    )

    // `other.txt` lives only under the second root, so it resolves only if that mount decorated.
    expect((await started.fetch('/elsewhere')).status).toBe(200)
  })

  it('leaves the decoration with the first mount when none asks', async () => {
    const started = await start(s => s.serve(fixtures, { prefix: '/a' }).serve(other, { prefix: '/b' }))

    expect((await started.fetch('/elsewhere')).status).toBe(404)
    expect((await started.fetch('/pick')).status).toBe(200)
  })

  it('fails with a named error when no mount decorated the reply', async () => {
    const started = await start(s => s.serve(fixtures, { decorateReply: false }))

    expect((await started.fetch('/pick')).status).toBe(500)
  })
})
