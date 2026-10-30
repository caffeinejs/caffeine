import { Controller, Get, Prefix, WebApplication } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { OpenAPI } from '../feature.js'
import { openapi } from '../openapi.js'
import { OpenAPIProvider } from '../provider.js'

// The controller's own path is /orders; the prefix is what puts it under /admin.
@Prefix('/admin')
@Controller('/orders')
class OrdersController {
  @Get('/')
  list() {
    return []
  }
}
void [OrdersController]

const catalog = () => newRouter('/products').get('/', () => [])

const isAdmin = (_group: unknown, _route: unknown, path: string) => path.startsWith('/admin')
const isStorefront = (_group: unknown, _route: unknown, path: string) => !path.startsWith('/admin')

describe('include on a prefixed controller', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Matching the router's path alone would publish the back office in the storefront's document.
  it('selects routes by the path the document publishes, prefix included', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi('storefront', o => o.docs(false).include(isStorefront)))
      .with(openapi('back-office', o => o.docs(false).include(isAdmin)))
      .mount(catalog()) as WebApplication
    await app.bootstrap()

    const provider = app.container.get(OpenAPIProvider)

    expect(Object.keys(provider.docs('storefront').paths ?? {})).toEqual(['/products'])
    expect(Object.keys(provider.docs('back-office').paths ?? {})).toEqual(['/admin/orders'])
  })
})
