import { token } from '@caffeinejs/di'
import { createWebApplication, type WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { openapi } from '../openapi.js'
import type { OpenAPIConfig } from '../options.js'
import { kBuild, OpenAPIOptionsBuilder } from '../options_builder.js'
import type { OpenAPIDocument } from '../spec/spec.js'

// What a fluent method sets is final, and `config(...)` fills in only what no method set: a deployment can
// retitle or move the document without touching code, and code that pins a setting keeps it.
describe('OpenAPIOptionsBuilder.config', () => {
  it('applies what no method set, over the defaults', () => {
    const options = new OpenAPIOptionsBuilder()
      .config({
        version: '3.2.0',
        info: { title: 'Configured', version: '1.0.0' },
        routes: { docs: false },
        infer: { auth: false },
      })
      [kBuild]()

    expect(options.version).toBe('3.2.0')
    expect(options.info).toEqual({ title: 'Configured', version: '1.0.0' })
    expect(options.routes).toEqual({ base: '/', json: '/openapi.json', yaml: '/openapi.yaml', docs: undefined })
    expect(options.infer).toEqual({ validation: true, auth: false })
  })

  it('lets a method win over the configuration, key by key within a block', () => {
    const options = new OpenAPIOptionsBuilder()
      .config({ version: '3.2.0', routes: { json: '/configured.json', docs: '/configured-docs' } })
      .version('3.1.1')
      .json('/coded.json')
      [kBuild]()

    expect(options.version).toBe('3.1.1')
    expect(options.routes.json).toBe('/coded.json')
    expect(options.routes.docs).toBe('/configured-docs')
  })

  it('replaces a configured list with the one the methods built', () => {
    const options = new OpenAPIOptionsBuilder()
      .config({ servers: [{ url: 'https://configured.example' }] })
      .server('https://coded.example')
      [kBuild]()

    expect(options.servers).toEqual([{ url: 'https://coded.example' }])
  })

  // A configuration snapshot is frozen; the generator owns the objects it builds the document from.
  it('builds from copies of the configured objects', () => {
    const info = Object.freeze({ title: 'Frozen', version: '1.0.0' })
    const options = new OpenAPIOptionsBuilder().config({ info })[kBuild]()

    options.info.title = 'Changed'

    expect(info.title).toBe('Frozen')
  })
})

describe('openapi() configured from the tree', () => {
  const schema = $t.Object({
    openapi: $t.Object(
      {
        info: $t.Optional($t.Unsafe<OpenAPIConfig['info']>($t.Record($t.String(), $t.Unknown()))),
        routes: $t.Optional(
          $t.Object({ json: $t.Optional($t.String()), docs: $t.Optional($t.Union([$t.String(), $t.Literal(false)])) }),
        ),
      },
      { default: {} },
    ),
  })

  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('serves the document where, and as, the configuration says', async () => {
    const conf = newConfiguration(schema)
      .source(
        new InlineConfigSource({
          openapi: { info: { title: 'From config', version: '2.0.0' }, routes: { json: '/spec.json', docs: false } },
        }),
      )
      .build().config

    app = createWebApplication({ config: conf }).with(
      openapi<InferConfig<typeof schema>>((o, { config }) => o.config(config.openapi).public()),
    ) as WebApplication
    await app.bootstrap()

    const document = (await (await app.fetch('/spec.json')).json()) as OpenAPIDocument

    expect(document.info).toEqual({ title: 'From config', version: '2.0.0' })
    expect((await app.fetch('/docs')).status).toBe(404)
  })
})
