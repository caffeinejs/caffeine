import { Injectable } from '@caffeinejs/di'
import { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { OpenAPI } from './feature.js'
import { openapi } from './openapi.js'
import { OpenAPIProvider } from './provider.js'

// A component that needs the document, not the endpoint serving it: what an integration such as Watt is. In a file
// of its own, because `@Injectable` registers it with every application built in the file.
@Injectable([OpenAPIProvider])
class DocumentPublisher {
  constructor(readonly provider: OpenAPIProvider) {}

  title(): string {
    return this.provider.docs().info.title
  }
}

describe('OpenAPI() and constructor injection', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The class itself is the key, so a constructor asks for it by type with no token to import.
  it('injects OpenAPIProvider by its class', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.info({ title: 'Shop', version: '1.0.0' }).docs(false))) as WebApplication
    await app.bootstrap()

    const publisher = app.container.get(DocumentPublisher)

    expect(publisher.provider).toBe(app.container.get(OpenAPIProvider))
    expect(publisher.title()).toBe('Shop')
  })
})
