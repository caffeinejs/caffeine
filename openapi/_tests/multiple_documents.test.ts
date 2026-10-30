import { $t } from '@caffeinejs/application/schema'
import { Authentication, Claim, Identity, Principal, WebApplication, bindTo } from '@caffeinejs/http'
import { authentication, createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrOpenAPIConfiguration } from '../errors.js'
import { OpenAPI } from '../feature.js'
import { openapi } from '../openapi.js'
import { OpenAPIProvider } from '../provider.js'
import type { OpenAPIDocument } from '../spec/spec.js'

const Product = $t.Object({ id: $t.String(), name: $t.String() }, { $id: 'Product' })
const Order = $t.Object({ id: $t.String(), total: $t.Number() }, { $id: 'Order' })

// A shop: the storefront's public API, and the back office under /admin on the same server.
function catalog() {
  const router = newRouter('/products').name('Catalog')
  router
    .get('/')
    .schema({ response: { 200: $t.Array(Product) } })
    .handler(() => [])
  return router
}

function backOffice() {
  const router = newRouter('/admin/orders').name('BackOffice')
  router
    .get('/')
    .schema({ response: { 200: $t.Array(Order) } })
    .handler(() => [])
  return router
}

const isAdmin = (_group: unknown, _route: unknown, path: string) => path.startsWith('/admin')
const isStorefront = (_group: unknown, _route: unknown, path: string) => !path.startsWith('/admin')

async function json(response: Response): Promise<OpenAPIDocument> {
  return (await response.json()) as OpenAPIDocument
}

async function warningsDuring(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const capture = (warning: Error | string) => {
    warnings.push(typeof warning === 'string' ? warning : warning.message)
  }
  process.on('warning', capture)

  try {
    await run()
    // process warnings are delivered on the next tick.
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    process.off('warning', capture)
  }

  return warnings
}

describe('several OpenAPI documents in one application', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Publishing the back office in the storefront's document would hand every client its admin endpoints.
  it('splits one server between documents with include, each describing only its own routes', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('storefront', o => o.info({ title: 'Storefront', version: '1.0.0' }).include(isStorefront)))
      .with(openapi('back-office', o => o.info({ title: 'Back office', version: '1.0.0' }).include(isAdmin)))
      .mount(catalog(), backOffice()) as WebApplication
    await app.bootstrap()

    const storefront = await json(await app.request('/openapi/storefront.json'))
    const backoffice = await json(await app.request('/openapi/back-office.json'))

    expect(Object.keys(storefront.paths ?? {})).toEqual(['/products'])
    expect(Object.keys(storefront.components?.schemas ?? {})).toEqual(['Product'])
    expect(Object.keys(backoffice.paths ?? {})).toEqual(['/admin/orders'])
    expect(Object.keys(backoffice.components?.schemas ?? {})).toEqual(['Order'])

    const provider = app.container.get(OpenAPIProvider)
    expect(provider.docs('storefront')).toEqual(storefront)
    expect(provider.docs('back-office')).toEqual(backoffice)
  })

  // Each named document gets its own default paths, so two of them never fight over /openapi.json.
  it('serves each named document at its own paths, UI included', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('storefront', o => o.include(isStorefront)))
      .with(openapi('back-office', o => o.include(isAdmin)))
      .mount(catalog(), backOffice()) as WebApplication
    await app.bootstrap()

    expect((await app.request('/openapi/storefront.yaml')).status).toBe(200)
    expect((await app.request('/openapi/back-office.yaml')).status).toBe(200)
    expect((await app.request('/openapi.json')).status).toBe(404)

    const page = await (await app.request('/docs/back-office')).text()
    expect(page).toContain('data-url="/openapi/back-office.json"')
    expect(page).toContain('src="/docs/back-office/_scalar.js"')
    expect((await app.request('/docs/back-office/_scalar.js')).status).toBe(200)
  })

  // A listener is a second server; the document registered on it sees only the routes bound to it.
  it('documents a listener on its own, beside the main server', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .listener('internal', l => l.with(openapi('internal', o => o.info({ title: 'Internal', version: '1.0.0' }))))
      .with(openapi(o => o.info({ title: 'Public', version: '1.0.0' })))
      .mount(catalog(), backOffice().extend(bindTo('internal'))) as WebApplication
    await app.bootstrap()

    const internal = await json(await app.listeners.get('internal')!.request('/openapi/internal.json'))
    const main = await json(await app.request('/openapi.json'))

    expect(Object.keys(internal.paths ?? {})).toEqual(['/admin/orders'])
    expect(Object.keys(main.paths ?? {})).toEqual(['/products'])
    expect(app.container.get(OpenAPIProvider).docs().info.title).toBe('Public')
    expect(app.container.get(OpenAPIProvider).docs('internal').info.title).toBe('Internal')
  })

  // A service migrating to Caffeine still has a hand-written contract for the routes it has not moved yet.
  it('serves an imported document beside a generated one', async () => {
    const legacy: OpenAPIDocument = {
      openapi: '3.1.1',
      info: { title: 'Legacy', version: '0.9.0' },
      paths: { '/v0/stock': { get: { operationId: 'stock', responses: { 200: { description: 'OK' } } } } },
    }

    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.docs(false)))
      .with(openapi('legacy', o => o.document(legacy).docs(false)))
      .mount(catalog()) as WebApplication
    await app.bootstrap()

    expect(Object.keys((await json(await app.request('/openapi.json'))).paths ?? {})).toEqual(['/products'])
    expect(await json(await app.request('/openapi/legacy.json'))).toEqual(legacy)
  })

  // The back office's description is internal; the storefront's is meant for everyone.
  it('secures one document while another stays public, warning only about the one left implicit', async () => {
    const warnings = await warningsDuring(async () => {
      app = createWebApplication({})
        .install(
          Authentication(a =>
            a.addBasic('Basic', b =>
              b.validate((_ctx, user, pass) =>
                user === 'ops' && pass === 'secret'
                  ? new Principal(true, [new Identity('Basic', true, [new Claim('sub', 'ops', '')])])
                  : null,
              ),
            ),
          ),
        )
        .with(authentication())
        .install(OpenAPI())
        .with(openapi('storefront', o => o.docs(false).include(isStorefront)))
        .with(openapi('back-office', o => o.docs(false).include(isAdmin).secure('Basic')))
        .mount(
          catalog().authorize({ allowAnonymous: true }),
          backOffice().authorize({ allowAnonymous: true }),
        ) as WebApplication
      await app.bootstrap()
    })

    const basic = `Basic ${Buffer.from('ops:secret').toString('base64')}`

    expect((await app!.request('/openapi/storefront.json')).status).toBe(200)
    expect((await app!.request('/openapi/back-office.json')).status).toBe(401)
    expect((await app!.request('/openapi/back-office.json', { headers: { authorization: basic } })).status).toBe(200)
    expect(warnings.filter(w => w.includes('is served publicly'))).toEqual([
      expect.stringContaining(
        'The OpenAPI document "storefront" is served publicly while authentication is configured',
      ),
    ])
  })

  // An internal service under Watt hands its document to the runtime and serves no endpoint of its own.
  it('generates a document that serves nothing, for a consumer of the provider alone', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.json(false).yaml(false).docs(false)))
      .mount(catalog()) as WebApplication
    await app.bootstrap()

    expect((await app.request('/openapi.json')).status).toBe(404)
    expect((await app.request('/openapi.yaml')).status).toBe(404)
    expect((await app.request('/docs')).status).toBe(404)
    expect(Object.keys(app.container.get(OpenAPIProvider).docs().paths ?? {})).toEqual(['/products'])
  })

  it('serves the YAML document alone when the JSON one is off', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.json(false).docs(false)))
      .mount(catalog()) as WebApplication
    await app.bootstrap()

    expect((await app.request('/openapi.json')).status).toBe(404)
    expect(await (await app.request('/openapi.yaml')).text()).toContain('/products:')
  })

  // A route the 3.1 document cannot hold is dropped from it alone, and the warning says which document dropped it.
  it('emits a 3.1.1 and a 3.2.0 document side by side', async () => {
    const search = () =>
      newRouter('/search')
        .name('Search')
        .route('QUERY', '/', () => [])

    const warnings = await warningsDuring(async () => {
      app = createWebApplication({})
        .install(OpenAPI())
        .with(openapi('v31', o => o.version('3.1.1').docs(false)))
        .with(openapi('v32', o => o.version('3.2.0').docs(false)))
        .mount(search()) as WebApplication
      await app.bootstrap()
    })

    const provider = app!.container.get(OpenAPIProvider)

    expect(provider.docs('v31').paths?.['/search']).toEqual({})
    expect(provider.docs('v32').paths?.['/search']?.additionalOperations?.QUERY?.operationId).toBe('Search_query_index')
    expect(warnings.filter(w => w.includes('cannot represent the "QUERY" method'))).toEqual([
      expect.stringMatching(/^OpenAPI document "v31": Route "QUERY \/search"/),
    ])
  })

  // The paths describe the routes as declared; the server entry is where a client finds them under the base.
  it('names the base path as the server of every document, and links each UI under it', async () => {
    app = createWebApplication({})
      .basePath('/shop')
      .install(OpenAPI())
      .with(openapi('storefront', o => o.include(isStorefront)))
      .with(openapi('back-office', o => o.include(isAdmin)))
      .mount(catalog(), backOffice()) as WebApplication
    await app.bootstrap()

    const storefront = await json(await app.request('/shop/openapi/storefront.json'))
    const backoffice = await json(await app.request('/shop/openapi/back-office.json'))
    const page = await (await app.request('/shop/docs/back-office')).text()

    expect(storefront.servers).toEqual([{ url: '/shop' }])
    expect(backoffice.servers).toEqual([{ url: '/shop' }])
    expect(page).toContain('data-url="/shop/openapi/back-office.json"')
  })

  it('fails start-up when two documents are given the same path', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('a', o => o.json('/openapi.json').yaml(false).docs(false)))
      .with(openapi('b', o => o.json('/openapi.json').yaml(false).docs(false))) as WebApplication

    const failure = await app.bootstrap().catch((error: unknown) => error)
    app = undefined

    expect((failure as { code?: string }).code).toBe('FST_ERR_DUPLICATED_ROUTE')
    expect((failure as Error).message).toContain('/openapi.json')
  })

  // The page loads the JSON document, so without it every browser opening the page would show an error.
  it('refuses a UI whose JSON endpoint is off', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('internal', o => o.json(false))) as WebApplication

    const failure = await app.bootstrap().catch((error: unknown) => error)
    app = undefined

    expect(failure).toBeInstanceOf(ErrOpenAPIConfiguration)
    expect((failure as Error).message).toContain(
      'Cannot serve the documentation UI of the OpenAPI document "internal": its JSON endpoint is off',
    )
    // The default document's path would collide with the default document itself.
    expect((failure as Error).message).toContain('Serve the JSON document with .json("/openapi/internal.json")')
  })

  // The name becomes a path segment and part of a route group's name.
  it('refuses a name that is not a path segment', () => {
    expect(() => openapi('back office')).toThrow(ErrOpenAPIConfiguration)
    expect(() => openapi('../admin')).toThrow(
      'Cannot register the OpenAPI document "../admin": a name holds only letters, digits, "-" and "_"',
    )
  })
})
