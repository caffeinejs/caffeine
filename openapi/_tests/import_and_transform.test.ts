import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $t } from '@caffeinejs/application/schema'
import {
  AllowAnonymous,
  Controller,
  Get,
  Header,
  Produces,
  RouteBuilder,
  Schema,
  WebApplication,
} from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrOpenAPIConfiguration } from '../errors.js'
import { OpenAPI } from '../feature.js'
import { openapi } from '../openapi.js'
import type { OpenAPIOptionsBuilder } from '../options_builder.js'
import type { OpenAPIDocument, OperationObject } from '../spec/spec.js'

@Controller('/widgets')
class WidgetsController {
  @Get('/')
  @AllowAnonymous()
  @Schema({ response: { 200: $t.Object({ id: $t.String() }, { $id: 'https://example.com/v1/Widget' }) } })
  @Header('x-request-id', 'generated')
  @Produces('application/json')
  list() {
    return []
  }
}
void [WidgetsController]

const HAND_WRITTEN: OpenAPIDocument = {
  openapi: '3.1.1',
  info: { title: 'Hand written', version: '9.9.9' },
  paths: {
    '/legacy': {
      get: { operationId: 'legacy', responses: { 200: { description: 'OK' } } },
    },
  },
}

function build(configure: (o: OpenAPIOptionsBuilder) => void): WebApplication {
  return createWebApplication({})
    .install(OpenAPI())
    .with(
      openapi(o => {
        o.docs(false).public()
        configure(o)
      }),
    ) as WebApplication
}

async function documentOf(app: WebApplication): Promise<OpenAPIDocument> {
  return (await (await app.request('/openapi.json')).json()) as OpenAPIDocument
}

describe('imported specifications', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('serves a document object verbatim, describing none of the application routes', async () => {
    app = build(o => o.document(HAND_WRITTEN))
    await app.bootstrap()

    const document = await documentOf(app)

    expect(document).toEqual(HAND_WRITTEN)
    expect(Object.keys(document.paths ?? {})).toEqual(['/legacy'])
  })

  it('reads a specification from a YAML file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'))
    const path = join(dir, 'spec.yaml')
    writeFileSync(path, 'openapi: 3.1.1\ninfo:\n  title: From YAML\n  version: 1.2.3\npaths: {}\n')

    app = build(o => o.specification({ path }))
    await app.bootstrap()

    const document = await documentOf(app)

    expect(document.info).toEqual({ title: 'From YAML', version: '1.2.3' })
  })

  it('reads a specification from a JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'))
    const path = join(dir, 'spec.json')
    writeFileSync(path, JSON.stringify(HAND_WRITTEN))

    app = build(o => o.specification({ path }))
    await app.bootstrap()

    expect((await documentOf(app)).info.title).toBe('Hand written')
  })

  it('fails at boot when the file does not exist', async () => {
    app = build(o => o.specification({ path: join(tmpdir(), 'definitely-not-here.yaml') }))

    await expect(app.bootstrap()).rejects.toThrow(/Cannot read the OpenAPI specification/)
    app = undefined
  })

  it('fails at boot when the file cannot be parsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'))
    const path = join(dir, 'spec.json')
    writeFileSync(path, '{ not json')

    app = build(o => o.specification({ path }))

    await expect(app.bootstrap()).rejects.toThrow(/Cannot parse the OpenAPI specification/)
    app = undefined
  })

  // The extension decides the parser, and the message must name the one that failed.
  it('names YAML as the format that failed for a .yaml file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'))
    const path = join(dir, 'spec.yaml')
    writeFileSync(path, 'openapi: [unclosed')

    app = build(o => o.specification({ path }))

    await expect(app.bootstrap()).rejects.toThrow(`Cannot parse the OpenAPI specification at "${path}" as YAML`)
    app = undefined
  })

  it('serves an imported document as YAML too', async () => {
    app = build(o => o.document(HAND_WRITTEN))
    await app.bootstrap()

    const res = await app.request('/openapi.yaml')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('title: Hand written')
  })
})

describe('transformDocument', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('runs on a generated document', async () => {
    app = build(o =>
      o.transformDocument(doc => {
        doc.info.title = 'Renamed'
      }),
    )
    await app.bootstrap()

    expect((await documentOf(app)).info.title).toBe('Renamed')
  })

  it('runs on an imported document too', async () => {
    app = build(o =>
      o.document(HAND_WRITTEN).transformDocument(doc => ({ ...doc, info: { ...doc.info, title: 'Patched' } })),
    )
    await app.bootstrap()

    expect((await documentOf(app)).info.title).toBe('Patched')
  })

  // The answer to the generator's blind spot: a route registered straight onto the server never reaches the
  // router table, so this is the only way to document it.
  it('can add a path the generator cannot see', async () => {
    app = build(o =>
      o.transformDocument(doc => {
        doc.paths = {
          ...doc.paths,
          '/plugin-route': { get: { operationId: 'pluginRoute', responses: { 200: { description: 'OK' } } } },
        }
      }),
    )
    await app.bootstrap()

    const document = await documentOf(app)

    expect(Object.keys(document.paths ?? {})).toContain('/plugin-route')
    expect(Object.keys(document.paths ?? {})).toContain('/widgets')
  })
})

describe('derived response detail', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('documents response headers the route already declares', async () => {
    app = build(() => {})
    await app.bootstrap()

    const document = await documentOf(app)
    const operation = (document.paths!['/widgets'] as Record<string, OperationObject>).get

    expect(operation.responses?.['200'].headers).toEqual({ 'x-request-id': { schema: { type: 'string' } } })
  })

  it('lets a schemaName override resolve what would otherwise be a colliding $id', async () => {
    app = build(o =>
      o.schemaName(schema => {
        const id = String(schema.$id ?? '')
        // Keep the version segment, so v1/Widget and v2/Widget are distinguishable.
        const match = /\/(v\d+)\/([^/]+)$/.exec(id)
        return match === null ? undefined : `${match[2]}${match[1].toUpperCase()}`
      }),
    )
    await app.bootstrap()

    const names = Object.keys((await documentOf(app)).components?.schemas ?? {})

    expect(names).toEqual(['WidgetV1'])
  })

  it('merges raw components the generator never produces', async () => {
    app = build(o =>
      o.components({
        responses: { NotFound: { description: 'Nothing there' } },
        parameters: { page: { name: 'page', in: 'query', schema: { type: 'integer' } } },
      }),
    )
    await app.bootstrap()

    const components = (await documentOf(app)).components

    expect(components?.responses?.NotFound).toEqual({ description: 'Nothing there' })
    expect(components?.parameters?.page).toMatchObject({ name: 'page', in: 'query' })
    // The generated schemas survive the merge.
    expect(Object.keys(components?.schemas ?? {})).toEqual(['Widget'])
  })
})

// Here rather than in `openapi.test.ts`: that file's controllers carry `@Roles`, and every application built in it
// must install authentication to start, which is exactly what these tests leave out.
describe('openapi without authentication', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

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

  // Nothing is secured, so a public document hides nothing and is not worth a line of output.
  it('serves the document publicly without a warning', async () => {
    const warnings = await warningsDuring(async () => {
      app = createWebApplication({})
        .install(OpenAPI())
        .with(openapi(o => o.docs(false))) as WebApplication
      await app.bootstrap()
    })

    expect((await app!.request('/openapi.json')).status).toBe(200)
    expect(warnings).toEqual([])
  })

  // Securing the endpoints with no scheme registered would protect them with nothing; the fix is to register one.
  it('refuses to secure the document, pointing at Authentication(...)', async () => {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.docs(false).secure('Basic'))) as WebApplication

    const failure = await app.bootstrap().catch((error: unknown) => error)
    app = undefined

    expect(failure).toBeInstanceOf(ErrOpenAPIConfiguration)
    expect((failure as Error).message).toContain(
      'Cannot secure the OpenAPI endpoints: no authentication scheme named "Basic" is registered',
    )
    expect((failure as Error).message).toContain('Register a scheme with .install(Authentication(')
  })

  // A route the document cannot represent is dropped, and the operator must hear about it at start-up.
  it('emits the warnings generation collected once the server is ready', async () => {
    const warnings = await warningsDuring(async () => {
      app = createWebApplication({})
        .install(OpenAPI())
        .with(openapi(o => o.docs(false)))
        .with(() => async (instance: FastifyInstance) => {
          instance.$route('search', router => {
            router.path('/search').routes([
              new RouteBuilder()
                .method('QUERY')
                .path('/')
                .handle(() => []),
            ])
          })
        }) as WebApplication
      await app.bootstrap()
    })

    expect(warnings.filter(w => w.includes('OpenAPI 3.1.1 cannot represent the "QUERY" method'))).toHaveLength(1)
  })
})
