import { token } from '@caffeinejs/di'
import {
  AllowAnonymous,
  Controller,
  Get,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import { $t, type InferSchema } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { OpenAPIExtension } from '../extension.js'
import { OpenAPIExt } from '../plugin.js'
import type { OpenAPIDocument } from '../spec/spec.js'

// The application owns the schema, so it declares where the OpenAPI block lives and points the feature there
// with `o.config(c => c.openapi)`. Declared field by field rather than by importing `openapiConfigSchema`:
// every field of `OpenAPIConfigSlice` is optional, so a block naming only what these tests configure
// satisfies the feature, and that schema is small enough for TypeScript to infer a config type from.
const rootSchema = $t.Object({
  openapi: $t.Object(
    {
      info: $t.Optional($t.Object({ title: $t.String(), version: $t.String() })),
      servers: $t.Optional($t.List($t.Object({ url: $t.String() }))),
      errors: $t.Optional(
        $t.Object({
          validation: $t.Optional($t.Number()),
          unauthorized: $t.Optional($t.Number()),
          forbidden: $t.Optional($t.Number()),
        }),
      ),
      routes: $t.Optional(
        $t.Object({
          json: $t.Optional($t.String()),
          yaml: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
          docs: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
        }),
      ),
    },
    { default: {} },
  ),
})
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

@Controller('/things')
class ThingsController {
  @Get('/')
  @AllowAnonymous()
  list(): unknown {
    return []
  }
}
void [ThingsController]

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

async function documentOf(app: WebApplication): Promise<OpenAPIDocument> {
  const res = await app.fetch('/openapi.json')
  return (await res.json()) as OpenAPIDocument
}

describe('openapi configuration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The plan's headline case: redirect the documented server URL per environment, no rebuild.
  it('lets the environment override a builder-set server URL', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ OPENAPI__SERVERS__0__URL: 'https://api.prod.example.com' }), ConfigPriority.ENV),
      )
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .info({ title: 'Things', version: '1.0.0' })
          .server('http://localhost:3000')
          .public(),
      )
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.servers).toEqual([{ url: 'https://api.prod.example.com' }])
    expect(doc.info.title).toBe('Things')
  })

  it('reads the info block from the configuration tree', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            openapi: { info: { title: 'From Config', version: '9.9.9' } },
          }),
        ),
      )
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .info({ title: 'From Code', version: '1.0.0' })
          .public(),
      )
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.info.title).toBe('From Config')
    expect(doc.info.version).toBe('9.9.9')
  })

  // A partial nested override must not wipe the sibling defaults.
  it('merges a partial errors block over the defaults', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            openapi: { errors: { validation: 422 } },
          }),
        ),
      )
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .info({ title: 'Things', version: '1.0.0' })
          .public(),
      )
      .build()

    await app.ready()

    // 422 came from configuration; 401/403 are still the defaults the builder started from.
    const options = app.container.get(OpenAPIExtension).options
    expect(options.errors).toEqual({ validation: 422, unauthorized: 401, forbidden: 403 })
    // `routes` was not configured here, so it is still what the builder started from.
    expect(options.routes.json).toBe('/openapi.json')
  })

  // The endpoints are registered while the feature configures, which now happens after configuration resolves.
  it('serves the documentation page at a configured route', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ OPENAPI__ROUTES__DOCS: '/reference' }), ConfigPriority.ENV))
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .info({ title: 'Things', version: '1.0.0' })
          .public(),
      )
      .build()

    await app.ready()

    expect((await app.fetch('/reference')).status).toBe(200)
    expect((await app.fetch('/docs')).status).toBe(404)
    // Only `docs` moved: the sibling routes keep the values the builder had.
    expect((await app.fetch('/openapi.json')).status).toBe(200)
  })

  it('switches an endpoint off when configuration says false', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ OPENAPI__ROUTES__YAML: 'false' }), ConfigPriority.ENV))
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .info({ title: 'Things', version: '1.0.0' })
          .public(),
      )
      .build()

    await app.ready()

    expect(app.container.get(OpenAPIExtension).options.routes.yaml).toBeUndefined()
    expect((await app.fetch('/openapi.yaml')).status).toBe(404)
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
    const schema = $t.Object({
      app: $t.Object({
        // Shaped like `InfoObject`, since the selector's return type is checked against the feature's own
        // config interface — that structural check is the point of re-pointing being typed at all.
        docs: $t.Object({
          info: $t.Optional($t.Object({ title: $t.String(), version: $t.String() })),
        }),
      }),
    })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(schema, kConfig, c =>
        c.source(
          new InlineConfigProvider({
            app: { docs: { info: { title: 'Moved', version: '2.0.0' } } },
          }),
        ),
      )
      // No annotation on the selector: the config type is recovered from the builder.
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.app.docs)
          .info({ title: 'Code', version: '1.0.0' })
          .public(),
      )
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.info.title).toBe('Moved')
  })

  // `transformDocument` edits the document in place, and the values now come from a deep-frozen tree.
  it('still lets transformDocument mutate a config-sourced info block', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            openapi: { info: { title: 'From Config', version: '1.0.0' } },
          }),
        ),
      )
      .extend(OpenAPIExt, o =>
        o
          .config(c => c.openapi)
          .public()
          .transformDocument(document => {
            document.info.title = 'Renamed'
          }),
      )
      .build()

    await app.ready()

    expect((await documentOf(app)).info.title).toBe('Renamed')
  })
})
