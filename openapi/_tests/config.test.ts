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
import {
  ConfigPriority,
  Configuration,
  EnvConfigProvider,
  InlineConfigProvider,
  type ConfigHandle,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { kOpenAPIOptions } from '../keys.js'
import { openapi } from '../plugin.js'
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

  // The headline case: redirect the documented server URL per environment, no rebuild. `.server(...)` is not
  // called here, so the block the callback wired is what the document carries.
  it('reads the server URL from the environment when the code names none', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ OPENAPI__SERVERS__0__URL: 'https://api.prod.example.com' }), ConfigPriority.ENV),
      )
      .extend(openapi((o, c) => o.withConfig(c.openapi).info({ title: 'Things', version: '1.0.0' }).public()))
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.servers).toEqual([{ url: 'https://api.prod.example.com' }])
    // Named in code, so it stands whatever the tree carries.
    expect(doc.info.title).toBe('Things')
  })

  it('reads the info block from the configuration tree when the code names none', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            openapi: { info: { title: 'From Config', version: '9.9.9' } },
          }),
        ),
      )
      .extend(openapi((o, c) => o.withConfig(c.openapi).public()))
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
      .extend(openapi((o, c) => o.withConfig(c.openapi).info({ title: 'Things', version: '1.0.0' }).public()))
      .build()

    await app.ready()

    // 422 came from configuration; 401/403 are still the defaults the builder started from.
    const options = app.container.get(kOpenAPIOptions)
    expect(options.errors).toEqual({ validation: 422, unauthorized: 401, forbidden: 403 })
    // `routes` was not configured here, so it is still what the builder started from.
    expect(options.routes.json).toBe('/openapi.json')
  })

  // The endpoints are registered while the feature configures, which now happens after configuration resolves.
  it('serves the documentation page at a configured route', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(rootSchema, kRootConfig, c => c.source(env({ OPENAPI__ROUTES__DOCS: '/reference' }), ConfigPriority.ENV))
      .extend(openapi((o, c) => o.withConfig(c.openapi).info({ title: 'Things', version: '1.0.0' }).public()))
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
      .extend(openapi((o, c) => o.withConfig(c.openapi).public()))
      .build()

    await app.ready()

    expect(app.container.get(kOpenAPIOptions).routes.yaml).toBeUndefined()
    expect((await app.fetch('/openapi.yaml')).status).toBe(404)
  })

  it('reads the info block from wherever the application put it', async () => {
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
      .extend(openapi((o, c) => o.withConfig(c.app.docs).public()))
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
      .extend(
        openapi((o, c) =>
          o
            .withConfig(c.openapi)
            .public()
            .transformDocument(document => {
              document.info.title = 'Renamed'
            }),
        ),
      )
      .build()

    await app.ready()

    expect((await documentOf(app)).info.title).toBe('Renamed')
  })
})

/**
 * An application defaults a feature it did not write by declaring the default in its own schema. That band sits
 * above the framework's defaults and below anything the application actually chose, so it fills in only what
 * nobody named — which is what makes it useful, and what makes its position load-bearing.
 */
describe('openapi defaults and the schema band', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const defaultedSchema = $t.Object({
    openapi: $t.Object(
      {
        // The block carries `default: {}` so `Value.Default` materializes it — a field default nested under an
        // optional block that has none of its own never reaches the schema band at all.
        info: $t.Optional(
          $t.Object(
            {
              title: $t.String({ default: 'From Schema' }),
              version: $t.String({ default: '2.0.0' }),
            },
            { default: {} },
          ),
        ),
        servers: $t.Optional(
          $t.List($t.Object({ url: $t.String() }), { default: [{ url: 'https://schema.example.com' }] }),
        ),
      },
      { default: {} },
    ),
  })
  const kDefaultedConfig = token<ConfigHandle<InferSchema<typeof defaultedSchema>>>(Symbol('app.config'))

  // `'API'` and `'0.0.0'` are the feature's own defaults. They have to lose to the application's schema, or an
  // application can never name a default for a feature it did not write.
  it('lets the application schema default a block the feature also defaults', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(defaultedSchema, kDefaultedConfig)
      .extend(openapi((o, c) => o.withConfig(c.openapi).public()))
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.info.title).toBe('From Schema')
    expect(doc.info.version).toBe('2.0.0')
  })

  // The feature's own `servers` default is an empty array, and an empty array claims its own path in the merge.
  // Published in the code band it would not merely lose to a schema default — it would erase it.
  it('keeps a schema-declared server list the feature would otherwise claim away', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(defaultedSchema, kDefaultedConfig)
      .extend(openapi((o, c) => o.withConfig(c.openapi).public()))
      .build()

    await app.ready()

    const doc = await documentOf(app)
    expect(doc.servers).toEqual([{ url: 'https://schema.example.com' }])
  })

  it('still lets a builder call beat the schema default', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(defaultedSchema, kDefaultedConfig)
      .extend(openapi((o, c) => o.withConfig(c.openapi).info({ title: 'From Code', version: '1.0.0' }).public()))
      .build()

    await app.ready()

    expect((await documentOf(app)).info.title).toBe('From Code')
  })

  it('lets the environment beat the schema default when the code names nothing', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .config(defaultedSchema, kDefaultedConfig, c =>
        c.source(env({ OPENAPI__INFO__TITLE: 'From Env' }), ConfigPriority.ENV),
      )
      .extend(openapi((o, c) => o.withConfig(c.openapi).public()))
      .build()

    await app.ready()

    expect((await documentOf(app)).info.title).toBe('From Env')
  })
})
