import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrOpenAPIDocumentNotFound } from './errors.js'
import { OpenAPI } from './feature.js'
import { openapi } from './openapi.js'
import { OpenAPIProvider } from './provider.js'

describe('OpenAPI()', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Two applications in one process must never read each other's documents.
  it('gives every application a provider of its own', async () => {
    const first = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.info({ title: 'First', version: '1.0.0' }).docs(false))) as WebApplication
    const second = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.info({ title: 'Second', version: '1.0.0' }).docs(false))) as WebApplication

    await first.bootstrap()
    await second.bootstrap()

    try {
      expect(first.container.get(OpenAPIProvider).docs().info.title).toBe('First')
      expect(second.container.get(OpenAPIProvider).docs().info.title).toBe('Second')
    } finally {
      await first.close()
      await second.close()
    }
  })

  // A plugin with nowhere to register its document fails at start-up, naming the fix, rather than serving a
  // document no other component can reach.
  it('is required by openapi()', async () => {
    app = createWebApplication({}).with(openapi()) as WebApplication

    const failure = await app.bootstrap().catch((error: unknown) => error)
    app = undefined

    expect(failure).toBeInstanceOf(ErrFeatureNotInstalled)
    expect((failure as ErrFeatureNotInstalled).code).toBe('ERR_FEATURE_NOT_INSTALLED')
    expect((failure as Error).message).toContain('Cannot use feature "openapi": it is not installed')
    expect((failure as Error).message).toContain('Install it with .install(OpenAPI()) on the application')
  })

  it('holds no document until a plugin registers one', async () => {
    app = createWebApplication({}).install(OpenAPI()) as WebApplication
    await app.bootstrap()

    const provider = app.container.get(OpenAPIProvider)

    expect(() => provider.docs()).toThrow(ErrOpenAPIDocumentNotFound)
    expect(() => provider.docs()).toThrow('Register it with .with(openapi()) on the application')
    expect(() => provider.docs('admin')).toThrow('Register it with .with(openapi("admin")) on the application')
    // Asked before the plugins have run, the document only looks missing.
    expect(() => provider.docs()).toThrow('Read it after await app.bootstrap() or app.run() resolves')
  })
})
