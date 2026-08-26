import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import { $t } from '@caffeinejs/std'
import {
  $p,
  AllowAnonymous,
  Controller,
  Get,
  Params,
  Post,
  Roles,
  Schema,
  Status,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import { APIGroup, Operation } from '../decorators/index.js'
import { ErrOpenAPIConfiguration } from '../errors.js'
import { openapiPlugin } from '../plugin.js'
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
  @Params([$p.param('id')])
  get(id: string) {
    return { id, name: 'Rex' }
  }

  @Post('/')
  @Status(201)
  @Roles('write:pets')
  @Schema({ body: petSchema })
  @Params([$p.body()])
  create(body: unknown) {
    return body
  }

  @Post('/:id/images')
  @Status(201)
  @Roles('write:pets')
  @Params([$p.param('id'), $p.file('file')])
  upload() {
    return { uploaded: true }
  }
}
void [PetsController]

function buildApp(configure: (app: ReturnType<typeof newBuilder>) => void = () => {}): WebApplication {
  const builder = newBuilder()
  configure(builder)
  return builder.build().useAuthenticationAndAuthorization() as WebApplication
}

// Authentication is always configured: the fixture controller carries @Roles and @AllowAnonymous, and an
// application declaring authorization without authentication refuses to start. It also means every test
// exercises the securityScheme derivation rather than only the unauthenticated path.
function newBuilder() {
  return createWebApplication(fastifyAdapterFactory(fastify()), {})
    .extend(openapiPlugin())
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
    app = buildApp(b => b.openapi(o => o
      .info({ title: 'Petstore', version: '1.0.0' })
      .docs(false)
      .public()))
    await app.ready()

    const res = await app.fetch('/openapi.json')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)

    const document = await res.json() as OpenAPIDocument
    expect(document.openapi).toBe('3.1.1')
    expect(document.info.title).toBe('Petstore')
  })

  it('describes the application\'s real routes', async () => {
    app = buildApp(b => b.openapi(o => o.docs(false).public()))
    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    expect(Object.keys(document.paths ?? {}).sort())
      .toEqual(['/pets', '/pets/{id}', '/pets/{id}/images'])
    expect(operationAt(document, '/pets')?.operationId).toBe('listPets')
    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
    expect(document.tags).toContainEqual({ name: 'Pets', description: 'Browse and manage pets' })
  })

  it('hoists $id schemas into components', async () => {
    app = buildApp(b => b.openapi(o => o.docs(false).public()))
    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    expect(document.components?.schemas?.Pet).toMatchObject({ type: 'object' })
    expect(operationAt(document, '/pets/{id}')?.responses?.['200'].content?.['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Pet' })
  })

  it('synthesizes a multipart body from the file picker', async () => {
    app = buildApp(b => b.openapi(o => o.docs(false).public()))
    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument
    const body = operationAt(document, '/pets/{id}/images', 'post')?.requestBody

    expect(body?.content['multipart/form-data'].schema).toMatchObject({
      properties: { file: { type: 'string', format: 'binary' } },
    })
  })

  it('does not describe its own endpoints', async () => {
    app = buildApp(b => b.openapi(o => o.docs(false).public()))
    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    expect(Object.keys(document.paths ?? {})).not.toContain('/openapi.json')
  })

  it('describes its own endpoints when asked', async () => {
    app = buildApp(b => b.openapi(o => o.docs(false).exposeSelf().public()))
    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    expect(Object.keys(document.paths ?? {})).toContain('/openapi.json')
  })

  it('serves the document as YAML', async () => {
    app = buildApp(b => b.openapi(o => o.info({ title: 'Petstore', version: '1.0.0' }).docs(false).public()))
    await app.ready()

    const res = await app.fetch('/openapi.yaml')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/yaml/)
    expect(await res.text()).toContain('title: Petstore')
  })

  it('disables the YAML endpoint on request', async () => {
    app = buildApp(b => b.openapi(o => o.yaml(false).docs(false).public()))
    await app.ready()

    expect((await app.fetch('/openapi.yaml')).status).toBe(404)
  })

  it('mounts everything under a configured base', async () => {
    app = buildApp(b => b.openapi(o => o.base('/internal').docs(false).public()))
    await app.ready()

    expect((await app.fetch('/internal/openapi.json')).status).toBe(200)
    expect((await app.fetch('/openapi.json')).status).toBe(404)
  })

  it('serves the documentation page and its bundle from the same origin', async () => {
    app = buildApp(b => b.openapi(o => o.info({ title: 'Petstore', version: '1.0.0' }).public()))
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
    app = buildApp(b => b.openapi(o => o.public()))
    await app.ready()

    const html = await (await app.fetch('/docs')).text()

    expect(html).toContain('data-configuration="{&quot;proxyUrl&quot;:&quot;&quot;}"')
    expect(html).not.toContain('proxy.scalar.com')
  })

  it('merges .ui() configuration over the defaults', async () => {
    app = buildApp(b => b.openapi(o => o.public().ui({ layout: 'classic', darkMode: true })))
    await app.ready()

    const html = await (await app.fetch('/docs')).text()
    const configuration = JSON.parse(
      /data-configuration="([^"]*)"/.exec(html)![1].replaceAll('&quot;', '"'),
    ) as Record<string, unknown>

    expect(configuration).toEqual({ proxyUrl: '', layout: 'classic', darkMode: true })
  })

  // The default is a default, not a decree: an application behind a corporate relay has to be able to name it.
  it('lets .ui() override the proxy the page pins', async () => {
    app = buildApp(b => b.openapi(o => o.public().ui({ proxyUrl: 'https://relay.internal' })))
    await app.ready()

    const html = await (await app.fetch('/docs')).text()

    expect(html).toContain('https://relay.internal')
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
    app = buildApp(b => b.openapi(o => o.docs(false).public()))
    await app.ready()

    expect((await app.fetch('/openapi.json')).status).toBe(200)
  })

  it('requires authentication once secured, even naming only a scheme', async () => {
    app = buildApp(b => b
      .authentication(auth => auth.addJWTBearer(j => j.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
      .openapi(o => o.docs(false).secure(s => s.schemes('Bearer'))))
    await app.ready()

    expect((await app.fetch('/openapi.json')).status).toBe(401)

    const token = await signToken({ sub: 'reader' })
    const authorized = await app.fetch('/openapi.json', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)
  })

  it('enforces roles on the document endpoints', async () => {
    app = buildApp(b => b
      .authentication(auth => auth.addJWTBearer(j => j.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
      .openapi(o => o.docs(false).secure(s => s.schemes('Bearer').roles('ops'))))
    await app.ready()

    const withoutRole = await signToken({ sub: 'reader' })
    expect((await app.fetch('/openapi.json', {
      headers: { authorization: `Bearer ${withoutRole}` },
    })).status).toBe(403)

    const withRole = await signToken({ sub: 'reader', roles: ['ops'] })
    expect((await app.fetch('/openapi.json', {
      headers: { authorization: `Bearer ${withRole}` },
    })).status).toBe(200)
  })

  it('warns when a secured application leaves its document public', async () => {
    const warnings: string[] = []
    const capture = (warning: Error | string) => {
      warnings.push(typeof warning === 'string' ? warning : warning.message)
    }
    process.on('warning', capture)

    try {
      app = buildApp(b => b.openapi(o => o.docs(false)))
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
      app = buildApp(b => b.openapi(o => o.docs(false).public()))
      await app.ready()
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('warning', capture)
    }

    expect(warnings.some(w => w.includes('served publicly while authentication is configured'))).toBe(false)
  })

  it('rejects a scheme name that was never registered', async () => {
    app = buildApp(b => b
      .authentication(auth => auth.addJWTBearer(j => j.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience()))
      .openapi(o => o.docs(false).secure(s => s.schemes('Nope'))))

    await expect(app.ready()).rejects.toThrow(ErrOpenAPIConfiguration)
    app = undefined
  })
})

describe('multiple applications in one process', () => {
  // The endpoints class is minted per builder precisely so this works: a module-level class would accumulate
  // a duplicate route per application and Fastify would reject the second registration.
  it('both serve their own document', async () => {
    const first = buildApp(b => b.openapi(o => o.info({ title: 'First', version: '1.0.0' }).docs(false).public()))
    const second = buildApp(b => b.openapi(o => o.info({ title: 'Second', version: '1.0.0' }).docs(false).public()))

    await first.ready()
    await second.ready()

    try {
      const a = await (await first.fetch('/openapi.json')).json() as OpenAPIDocument
      const b = await (await second.fetch('/openapi.json')).json() as OpenAPIDocument

      expect(a.info.title).toBe('First')
      expect(b.info.title).toBe('Second')
      expect(Object.keys(a.paths ?? {})).toEqual(Object.keys(b.paths ?? {}))
    } finally {
      await first.close()
      await second.close()
    }
  })
})
