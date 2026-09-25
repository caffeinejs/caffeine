import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  $p,
  AllowAnonymous,
  Controller,
  Get,
  Args,
  Post,
  Roles,
  RouteBuilder,
  Schema,
  Status,
  WebApplication,
  createWebApplication,
} from '@caffeinejs/http'
import { $multipart } from '@caffeinejs/multipart'
import { $t } from '@caffeinejs/std/schema'
import { type FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'

import { APIGroup, Operation } from '../decorators/index.js'
import { ErrOpenAPIConfiguration } from '../errors.js'
import { openapi, type OpenAPIConfigurer } from '../openapi.js'
import type { OpenAPIDocument, OperationObject } from '../spec/spec.js'

const TEST_SECRET = 'test-secret-key-must-be-at-least-32-chars!!'

function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET))
}

const petSchema = $t.Object({ id: $t.String(), name: $t.String() }, { $id: 'Pet' })

@APIGroup({ name: 'Pets', description: 'Browse and manage pets' })
@Controller('/pets')
class PetsController {
  @Get('/')
  @AllowAnonymous()
  @Schema({ response: { 200: $t.Array(petSchema) } })
  @Operation({ summary: 'List pets', operationId: 'listPets' })
  list() {
    return []
  }

  @Get('/:id')
  @AllowAnonymous()
  @Schema({ params: $t.Object({ id: $t.String() }), response: { 200: petSchema } })
  @Args([$p.param('id')])
  get(id: string) {
    return { id, name: 'Rex' }
  }

  @Post('/')
  @Status(201)
  @Roles('write:pets')
  @Schema({ body: petSchema })
  @Args([$p.body()])
  create(body: unknown) {
    return body
  }

  @Post('/:id/images')
  @Status(201)
  @Roles('write:pets')
  @Args([$p.param('id'), $multipart.file('file')])
  upload() {
    return { uploaded: true }
  }
}
void [PetsController]

function buildApp(configure: OpenAPIConfigurer = () => {}): WebApplication {
  return newBuilder(configure) as WebApplication
}

// Authentication is always configured: the fixture controller carries @Roles and @AllowAnonymous, and an
// application declaring authorization without authentication refuses to start. It also means every test
// exercises the securityScheme derivation rather than only the unauthenticated path.
function newBuilder(configure?: OpenAPIConfigurer) {
  return createWebApplication({})
    .with(openapi(configure))
    .authentication(auth => auth.addJWTBearer(j => j.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
}

function operationAt(document: OpenAPIDocument, path: string, method = 'get'): OperationObject | undefined {
  return (document.paths?.[path] as Record<string, OperationObject> | undefined)?.[method]
}

describe('openapi endpoints', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('serves the document as JSON', async () => {
    app = buildApp(o => o.info({ title: 'Petstore', version: '1.0.0' }).docs(false).public())
    await app.ready()

    const res = await app.fetch('/openapi.json')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)

    const document = (await res.json()) as OpenAPIDocument
    expect(document.openapi).toBe('3.1.1')
    expect(document.info.title).toBe('Petstore')
  })

  it("describes the application's real routes", async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument

    expect(Object.keys(document.paths ?? {}).sort()).toEqual(['/pets', '/pets/{id}', '/pets/{id}/images'])
    expect(operationAt(document, '/pets')?.operationId).toBe('listPets')
    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
    expect(document.tags).toContainEqual({ name: 'Pets', description: 'Browse and manage pets' })
  })

  it('hoists $id schemas into components', async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument

    expect(document.components?.schemas?.Pet).toMatchObject({ type: 'object' })
    expect(operationAt(document, '/pets/{id}')?.responses?.['200'].content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Pet',
    })
  })

  it('synthesizes a multipart body from the file picker', async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument
    const body = operationAt(document, '/pets/{id}/images', 'post')?.requestBody

    expect(body?.content['multipart/form-data'].schema).toMatchObject({
      properties: { file: { type: 'string', format: 'binary' } },
    })
  })

  // The package's own endpoints register like every other route and are collected with them; their group is
  // marked hidden, which is what keeps them out of the document.
  it('does not describe its own endpoints', async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument

    expect(Object.keys(document.paths ?? {})).not.toContain('/openapi.json')
  })

  // The document is generated once every route has registered, not when the plugin does, so the order the
  // plugins were installed in cannot drop a route from it.
  it('describes a route a plugin installed after it adds', async () => {
    app = newBuilder(o => o.docs(false).public()).with(() => async (instance: FastifyInstance) => {
      instance.$route('late', router => {
        router.path('/late').routes([
          new RouteBuilder()
            .method('GET')
            .path('/hello')
            .handle(() => ({ ok: true })),
        ])
      })
    }) as WebApplication
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument

    expect(Object.keys(document.paths ?? {})).toContain('/late/hello')
  })

  // A route a feature registers on the application's behalf — a single-page application's shell — is not part
  // of the API it describes. `detail('http', { internal: true })` is http's own marker for that.
  it('does not describe a group another feature marked internal', async () => {
    app = newBuilder(o => o.docs(false).public()).with(() => async (instance: FastifyInstance) => {
      instance.$route('shell', router => {
        router.detail('http', { internal: true })
        router.routes([
          new RouteBuilder()
            .method('GET')
            .path('/*')
            .handle(() => 'shell'),
        ])
      })
    }) as WebApplication
    await app.ready()

    const document = (await (await app.fetch('/openapi.json')).json()) as OpenAPIDocument

    expect(Object.keys(document.paths ?? {})).not.toContain('/{wildcard}')
    expect(Object.keys(document.paths ?? {})).toContain('/pets')
  })

  it('serves the document as YAML', async () => {
    app = buildApp(o => o.info({ title: 'Petstore', version: '1.0.0' }).docs(false).public())
    await app.ready()

    const res = await app.fetch('/openapi.yaml')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/yaml/)
    expect(await res.text()).toContain('title: Petstore')
  })

  it('disables the YAML endpoint on request', async () => {
    app = buildApp(o => o.yaml(false).docs(false).public())
    await app.ready()

    expect((await app.fetch('/openapi.yaml')).status).toBe(404)
  })

  it('mounts everything under a configured base', async () => {
    app = buildApp(o => o.base('/internal').docs(false).public())
    await app.ready()

    expect((await app.fetch('/internal/openapi.json')).status).toBe(200)
    expect((await app.fetch('/openapi.json')).status).toBe(404)
  })

  it('serves the documentation page and its bundle from the same origin', async () => {
    app = buildApp(o => o.info({ title: 'Petstore', version: '1.0.0' }).public())
    await app.ready()

    const page = await app.fetch('/docs')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)

    const html = await page.text()
    expect(html).toContain('data-url="/openapi.json"')
    expect(html).toContain('<title>Petstore</title>')
    expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/)

    const asset = await app.fetch('/docs/_scalar.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  /**
   * Serving the bundle from this origin is pointless if the requests the page then makes are relayed through
   * someone else's server, which is what the UI does by default: every "Try it" URL, header and credential
   * would leave the machine. It also breaks a cookie-authenticated API outright, since a relayed request
   * carries none of the caller's cookies.
   */
  it('pins the UI proxy off so requests go straight from the browser', async () => {
    app = buildApp(o => o.public())
    await app.ready()

    const html = await (await app.fetch('/docs')).text()

    expect(html).toContain('data-configuration="{&quot;proxyUrl&quot;:&quot;&quot;}"')
    expect(html).not.toContain('proxy.scalar.com')
  })

  it('merges .ui() configuration over the defaults', async () => {
    app = buildApp(o => o.public().ui({ layout: 'classic', darkMode: true }))
    await app.ready()

    const html = await (await app.fetch('/docs')).text()
    const configuration = JSON.parse(/data-configuration="([^"]*)"/.exec(html)![1].replaceAll('&quot;', '"')) as Record<
      string,
      unknown
    >

    expect(configuration).toEqual({ proxyUrl: '', layout: 'classic', darkMode: true })
  })

  // The default is a default, not a decree: an application behind a corporate relay has to be able to name it.
  it('lets .ui() override the proxy the page pins', async () => {
    app = buildApp(o => o.public().ui({ proxyUrl: 'https://relay.internal' }))
    await app.ready()

    const html = await (await app.fetch('/docs')).text()

    expect(html).toContain('https://relay.internal')
  })
})

/**
 * Behind a gateway forwarding `/api/...`, where the server takes the base off a request before routing. The
 * document describes the routes as the application declares them and names the base as the server they are on;
 * the documentation page's links are followed by a browser, so they carry the base.
 */
describe('openapi under a base path', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function documentOf(running: WebApplication, url = '/api/openapi.json'): Promise<OpenAPIDocument> {
    const res = await running.fetch(url)
    expect(res.status).toBe(200)
    return (await res.json()) as OpenAPIDocument
  }

  it('names the base path as the server, keeping the paths as the application declares them', async () => {
    app = newBuilder(o => o.docs(false).public()).basePath('/api') as WebApplication
    await app.ready()

    const document = await documentOf(app)

    expect(document.servers).toEqual([{ url: '/api' }])
    expect(operationAt(document, '/pets')).toBeDefined()
    expect(document.paths?.['/api/pets']).toBeUndefined()
  })

  it('keeps the servers the application declared, adding none of its own', async () => {
    app = newBuilder(o => o.server('https://api.example.com/v1').docs(false).public()).basePath(
      '/api',
    ) as WebApplication
    await app.ready()

    expect((await documentOf(app)).servers).toEqual([{ url: 'https://api.example.com/v1' }])
  })

  it('names no server without a base path, as it always has', async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    expect('servers' in (await documentOf(app, '/openapi.json'))).toBe(false)
  })

  it('leaves an imported document as it was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-base-'))
    const path = join(dir, 'spec.yaml')
    writeFileSync(path, 'openapi: 3.1.1\ninfo:\n  title: Imported\n  version: 1.0.0\npaths: {}\n')

    app = newBuilder(o => o.specification({ path }).docs(false).public()).basePath('/api') as WebApplication
    await app.ready()

    expect('servers' in (await documentOf(app))).toBe(false)
  })

  it('links the documentation page to its document and bundle under the base', async () => {
    app = newBuilder(o => o.public()).basePath('/api') as WebApplication
    await app.ready()

    const html = await (await app.fetch('/api/docs')).text()

    expect(html).toContain('data-url="/api/openapi.json"')
    expect(html).toContain('src="/api/docs/_scalar.js"')
    // Followed through the gateway, and just as well straight to the application.
    for (const url of ['/api/openapi.json', '/api/docs/_scalar.js', '/openapi.json', '/docs/_scalar.js']) {
      expect((await app.fetch(url)).status).toBe(200)
    }
  })

  it('puts the base path in front of a configured endpoint base', async () => {
    app = newBuilder(o => o.base('/internal').public()).basePath('/api') as WebApplication
    await app.ready()

    const html = await (await app.fetch('/api/internal/docs')).text()

    expect(html).toContain('data-url="/api/internal/openapi.json"')
    expect(html).toContain('src="/api/internal/docs/_scalar.js"')
  })
})

describe('openapi endpoint protection', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('is public by default', async () => {
    app = buildApp(o => o.docs(false).public())
    await app.ready()

    expect((await app.fetch('/openapi.json')).status).toBe(200)
  })

  it('requires authentication once secured, even naming only a scheme', async () => {
    app = buildApp(o => o.docs(false).secure(s => s.schemes('Bearer')))
    await app.ready()

    expect((await app.fetch('/openapi.json')).status).toBe(401)

    const token = await signToken({ sub: 'reader' })
    const authorized = await app.fetch('/openapi.json', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)
  })

  it('enforces roles on the document endpoints', async () => {
    app = buildApp(o => o.docs(false).secure(s => s.schemes('Bearer').roles('ops')))
    await app.ready()

    const withoutRole = await signToken({ sub: 'reader' })
    expect(
      (
        await app.fetch('/openapi.json', {
          headers: { authorization: `Bearer ${withoutRole}` },
        })
      ).status,
    ).toBe(403)

    const withRole = await signToken({ sub: 'reader', roles: ['ops'] })
    expect(
      (
        await app.fetch('/openapi.json', {
          headers: { authorization: `Bearer ${withRole}` },
        })
      ).status,
    ).toBe(200)
  })

  it('warns when a secured application leaves its document public', async () => {
    const warnings: string[] = []
    const capture = (warning: Error | string) => {
      warnings.push(typeof warning === 'string' ? warning : warning.message)
    }
    process.on('warning', capture)

    try {
      app = buildApp(o => o.docs(false))
      await app.ready()
      // process warnings are delivered on the next tick.
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('warning', capture)
    }

    expect(warnings.some(w => w.includes('served publicly while authentication is configured'))).toBe(true)
  })

  it('stays quiet once the choice is explicit', async () => {
    const warnings: string[] = []
    const capture = (warning: Error | string) => {
      warnings.push(typeof warning === 'string' ? warning : warning.message)
    }
    process.on('warning', capture)

    try {
      app = buildApp(o => o.docs(false).public())
      await app.ready()
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('warning', capture)
    }

    expect(warnings.some(w => w.includes('served publicly while authentication is configured'))).toBe(false)
  })

  it('rejects a scheme name that was never registered', async () => {
    app = buildApp(o => o.docs(false).secure(s => s.schemes('Nope')))

    await expect(app.ready()).rejects.toThrow(ErrOpenAPIConfiguration)
    app = undefined
  })
})

describe('multiple applications in one process', () => {
  // Each `openapi(...)` call builds its own plugin closure over its own generated document — nothing shared
  // at module scope for a second application to collide with.
  it('both serve their own document', async () => {
    const first = buildApp(o => o.info({ title: 'First', version: '1.0.0' }).docs(false).public())
    const second = buildApp(o => o.info({ title: 'Second', version: '1.0.0' }).docs(false).public())

    await first.ready()
    await second.ready()

    try {
      const a = (await (await first.fetch('/openapi.json')).json()) as OpenAPIDocument
      const b = (await (await second.fetch('/openapi.json')).json()) as OpenAPIDocument

      expect(a.info.title).toBe('First')
      expect(b.info.title).toBe('Second')
      expect(Object.keys(a.paths ?? {})).toEqual(Object.keys(b.paths ?? {}))
    } finally {
      await first.close()
      await second.close()
    }
  })
})
