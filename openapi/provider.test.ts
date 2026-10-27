import { WebApplication } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ErrOpenAPIConfiguration,
  ErrOpenAPIDocumentAmbiguous,
  ErrOpenAPIDocumentNotFound,
  ErrOpenAPIDocumentNotReady,
} from './errors.js'
import { OpenAPI } from './feature.js'
import { openapi } from './openapi.js'
import { OpenAPIProvider } from './provider.js'
import type { OpenAPIDocument } from './spec/spec.js'

const items = () => newRouter('/items').get('/', () => [])

describe('OpenAPIProvider', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function provider(): OpenAPIProvider {
    return app!.container.get(OpenAPIProvider)
  }

  // Most applications have one document, so asking for "the document" needs no name.
  it('returns the default document without a name, the same object the endpoint serves', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.info({ title: 'Shop', version: '1.0.0' }).docs(false)))
      .mount(items()) as WebApplication
    await app.bootstrap()

    const served = (await (await app.request('/openapi.json')).json()) as OpenAPIDocument

    expect(provider().docs()).toBe(provider().docs('default'))
    expect(provider().docs()).toEqual(served)
    expect(Object.keys(provider().docs().paths ?? {})).toEqual(['/items'])
  })

  it('returns the only document without a name when it is not called default', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('public', o => o.info({ title: 'Public', version: '1.0.0' }).docs(false))) as WebApplication
    await app.bootstrap()

    expect(provider().docs().info.title).toBe('Public')
  })

  it('prefers the default document when several are registered', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('admin', o => o.info({ title: 'Admin', version: '1.0.0' }).docs(false)))
      .with(openapi(o => o.info({ title: 'Main', version: '1.0.0' }).docs(false))) as WebApplication
    await app.bootstrap()

    expect(provider().docs().info.title).toBe('Main')
    expect(provider().docs('admin').info.title).toBe('Admin')
  })

  // Picking one of several would hand a consumer the wrong API without a word.
  it('refuses to guess between several documents when none is default', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('public', o => o.docs(false)))
      .with(openapi('admin', o => o.docs(false))) as WebApplication
    await app.bootstrap()

    expect(() => provider().docs()).toThrow(ErrOpenAPIDocumentAmbiguous)
    expect(() => provider().docs()).toThrow(
      'Cannot choose an OpenAPI document: 2 are registered and none is named "default"',
    )
    expect(() => provider().docs()).toThrow('Name the one to read: docs("public"), docs("admin")')
  })

  it('names the registered documents when asked for one that does not exist', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('public', o => o.docs(false))) as WebApplication
    await app.bootstrap()

    expect(() => provider().docs('admn')).toThrow(ErrOpenAPIDocumentNotFound)
    expect(() => provider().docs('admn')).toThrow('Cannot find the OpenAPI document "admn"')
    expect(() => provider().docs('admn')).toThrow('Ask for one of the registered documents: "public"')
  })

  // Documents are generated once every route has registered; reading one earlier has nothing correct to return.
  it('refuses to hand out a document before the server is ready', async () => {
    let early: unknown

    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.docs(false)))
      .with(context => {
        try {
          context.container.get(OpenAPIProvider).docs()
        } catch (error) {
          early = error
        }
        return async () => {}
      }) as WebApplication
    await app.bootstrap()

    expect(early).toBeInstanceOf(ErrOpenAPIDocumentNotReady)
    expect((early as ErrOpenAPIDocumentNotReady).code).toBe('ERR_OPENAPI_DOCUMENT_NOT_READY')
    expect((early as Error).message).toContain('Read it after await app.bootstrap() or app.run() resolves')
    expect(provider().docs().info.title).toBe('API')
  })

  // Two plugins writing one name would leave one document unreachable, decided by plugin order.
  it('refuses two plugins registering the same name at start-up', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('admin', o => o.docs(false)))
      .with(openapi('admin', o => o.json('/other.json').yaml(false).docs(false))) as WebApplication

    const failure = await app.bootstrap().catch((error: unknown) => error)
    app = undefined

    expect(failure).toBeInstanceOf(ErrOpenAPIConfiguration)
    expect((failure as Error).message).toContain(
      'Cannot register the OpenAPI document "admin": another openapi() plugin already registered it',
    )
  })

  describe('the document it hands out', () => {
    // The provider returns the very object the endpoints serve; changing it would change the API's published shape.
    it('cannot be changed by a consumer', async () => {
      app = createWebApplication({})
        .install(OpenAPI())
        .with(openapi(o => o.docs(false)))
        .mount(items()) as WebApplication
      await app.bootstrap()

      const document = provider().docs()

      expect(() => {
        document.info.title = 'Changed'
      }).toThrow(TypeError)
      expect(() => {
        delete document.paths?.['/items']
      }).toThrow(TypeError)
      expect(((await (await app.request('/openapi.json')).json()) as OpenAPIDocument).info.title).toBe('API')
    })

    // Freezing a copy leaves the objects the application handed the builder as writable as they were.
    it('is a copy of what the application passed in', async () => {
      const info = { title: 'Shop', version: '1.0.0' }
      const imported: OpenAPIDocument = { openapi: '3.1.1', info: { title: 'Imported', version: '1.0.0' }, paths: {} }

      app = createWebApplication({})
        .install(OpenAPI())
        .with(openapi(o => o.info(info).docs(false)))
        .with(openapi('legacy', o => o.document(imported).docs(false))) as WebApplication
      await app.bootstrap()

      expect(provider().docs().info).toEqual(info)
      expect(Object.isFrozen(info)).toBe(false)
      expect(Object.isFrozen(imported)).toBe(false)
      expect(provider().docs('legacy')).not.toBe(imported)
    })
  })
})
