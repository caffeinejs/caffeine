import { $t } from '@caffeinejs/application/schema'
import { $p, kRouteConstraints, type IRoute } from '@caffeinejs/http'
import { $multipart } from '@caffeinejs/multipart'
import { describe, expect, it } from 'vitest'

import { ErrOpenAPIOperationConflict } from '../errors.js'
import { generateDocument } from '../generate/generator.js'
import { deriveSecurity } from '../generate/security.js'
import type { OperationObject } from '../spec/spec.js'
import { fixtureOptions, fixtureRoute, fixtureRouter } from './_fixtures.js'

const petSchema = $t.Object({ id: $t.String(), name: $t.String() }, { $id: 'Pet' })
const petIdParams = $t.Object({ id: $t.String({ format: 'uuid' }) })
const errorSchema = $t.Object({ message: $t.String(), statusCode: $t.Integer() })

function operationAt(document: ReturnType<typeof generateDocument>, path: string, method = 'get') {
  return (document.paths?.[path] as Record<string, OperationObject> | undefined)?.[method]
}

describe('generateDocument', () => {
  it('emits the version, info and a path per route', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list')]))

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({ info: { title: 'Petstore', version: '2.0.0' } }),
    })

    expect(document.openapi).toBe('3.1.1')
    expect(document.info).toEqual({ title: 'Petstore', version: '2.0.0' })
    expect(Object.keys(document.paths ?? {})).toEqual(['/pets'])
    expect(operationAt(document, '/pets')?.operationId).toBe('Fixture_list')
  })

  it('derives the tag from the controller name and the operationId from the handler', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list')]), {
      name: 'PetsController',
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
    expect(operationAt(document, '/pets')?.operationId).toBe('Pets_list')
  })

  it('applies the router prefix to the path', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/:id', 'get')]), {
      prefix: '/api',
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(Object.keys(document.paths ?? {})).toEqual(['/api/pets/{id}'])
  })

  it('throws on a duplicate operationId, naming both sites', () => {
    const a = fixtureRouter(
      '/a',
      r => r.routes([fixtureRoute('GET', '/', 'list').detail('openapi', { operationId: 'listThings' })]),
      { name: 'AController' },
    )
    const b = fixtureRouter(
      '/b',
      r => r.routes([fixtureRoute('GET', '/', 'index').detail('openapi', { operationId: 'listThings' })]),
      { name: 'BController' },
    )

    expect(() => generateDocument({ routeGroups: [a, b], options: fixtureOptions() })).toThrow(
      ErrOpenAPIOperationConflict,
    )
    expect(() => generateDocument({ routeGroups: [a, b], options: fixtureOptions() })).toThrow(
      /AController\.list.*BController\.index/s,
    )
  })

  it('hoists a schema carrying $id into components and references it', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/:id', 'get').schema({ params: petIdParams, response: { 200: petSchema } })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(document.components?.schemas?.Pet).toMatchObject({ type: 'object' })
    expect(operationAt(document, '/pets/{id}')?.responses?.['200'].content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Pet',
    })
  })

  it('explodes @Schema slots into parameters with the right required flags', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/', 'list').schema({
          querystring: $t.Object({ page: $t.Optional($t.Integer()), status: $t.String() }),
        }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const parameters = operationAt(document, '/pets')?.parameters ?? []

    expect(parameters).toContainEqual(expect.objectContaining({ name: 'page', in: 'query', required: false }))
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'status', in: 'query', required: true }))
  })

  it('falls back to $p pickers when a slot has no schema', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/:id', 'get').parameters([$p.param('id'), $p.query('page')])]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const parameters = operationAt(document, '/pets/{id}')?.parameters ?? []

    expect(parameters).toContainEqual(expect.objectContaining({ name: 'id', in: 'path', required: true }))
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'page', in: 'query', required: false }))
  })

  it('marks a path parameter required even when the schema says otherwise', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/:id', 'get').schema({ params: $t.Object({ id: $t.Optional($t.String()) }) })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const id = operationAt(document, '/pets/{id}')?.parameters?.find(p => p.name === 'id')

    expect(id?.required).toBe(true)
  })

  it('never documents credential headers as parameters', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/', 'list').schema({
          headers: $t.Object({ authorization: $t.String(), 'x-trace-id': $t.Optional($t.String()) }),
        }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const names = (operationAt(document, '/pets')?.parameters ?? []).map(p => p.name)

    expect(names).not.toContain('authorization')
    expect(names).toContain('x-trace-id')
  })

  it('builds a request body from @Schema({ body })', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').schema({ body: petSchema }).statusCode(201)]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const operation = operationAt(document, '/pets', 'post')

    expect(operation?.requestBody?.required).toBe(true)
    expect(operation?.requestBody?.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Pet' })
    expect(Object.keys(operation?.responses ?? {})).toContain('201')
  })

  it('synthesizes a multipart body from file pickers', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/:id/images', 'upload').parameters([$p.param('id'), $multipart.file('file')])]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const body = operationAt(document, '/pets/{id}/images', 'post')?.requestBody

    expect(body?.content['multipart/form-data'].schema).toEqual({
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    })
  })

  it('documents a $t.File body as multipart, which is all a handler taking no pickers can declare', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('POST', '/:id/images', 'upload').schema({
          body: $t.Object({ file: $t.File(), caption: $t.String() }),
        }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const body = operationAt(document, '/pets/{id}/images', 'post')?.requestBody

    expect(body?.required).toBe(true)
    expect(body?.content['application/json']).toBeUndefined()
    expect(body?.content['multipart/form-data'].schema).toMatchObject({
      properties: {
        file: { type: 'string', format: 'binary' },
        caption: { type: 'string' },
      },
    })
  })

  it('omits a request body on a GET', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list').parameters([$p.body()])]))

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.requestBody).toBeUndefined()
  })

  it('emits no content for a 204', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('DELETE', '/:id', 'remove').statusCode(204)]))

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const responses = operationAt(document, '/pets/{id}', 'delete')?.responses

    expect(responses?.['204']).toEqual({ description: 'No Content' })
  })
})

describe('response inference', () => {
  it('adds the validation status when a request slot has a schema', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').schema({ body: petSchema })]),
    )

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({ errorSchema: errorSchema }),
    })

    expect(Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})).toContain('400')
  })

  it('honours a configured validation status', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').schema({ body: petSchema })]),
    )

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({ errors: { validation: 422, unauthorized: 401, forbidden: 403 } }),
    })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toContain('422')
    expect(statuses).not.toContain('400')
  })

  it('adds 401 and 403 on a protected route', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').authorize({ roles: ['write:pets'] })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toContain('401')
    expect(statuses).toContain('403')
  })

  it('infers nothing when inference is off', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').schema({ body: petSchema }).authorize()]),
    )

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({ infer: { validation: false, auth: false } }),
    })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toEqual(['200'])
  })

  it('lets a declared response win over an inferred one', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('POST', '/', 'create').schema({
          body: petSchema,
          response: { 400: $t.Object({ detail: $t.String() }) },
        }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const declared = operationAt(document, '/pets', 'post')?.responses?.['400']

    expect(declared?.content?.['application/json'].schema).toMatchObject({
      properties: { detail: { type: 'string' } },
    })
  })

  it('normalizes a lowercase wildcard status to the spec form', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/', 'list').schema({ response: { '4xx': errorSchema } })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(Object.keys(operationAt(document, '/pets')?.responses ?? {})).toContain('4XX')
  })
})

describe('security', () => {
  const schemes = new Map([['Bearer', { kind: 'http' as const, scheme: 'bearer', bearerFormat: 'JWT' }]])

  it('derives securitySchemes from the registered authentication schemes', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list')]))

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes })

    expect(document.components?.securitySchemes?.Bearer).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
  })

  it('emits a security requirement from @Authorize', () => {
    const router = fixtureRouter(
      '/pets',
      r => r.routes([fixtureRoute('POST', '/', 'create').authorize({ schemes: ['Bearer'] })]),
      { defaultScheme: 'Bearer' },
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets', 'post')?.security).toEqual([{ Bearer: [] }])
  })

  it('emits an empty requirement for @AllowAnonymous, opting out of the document default', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/', 'list').authorize({ allowAnonymous: true })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets')?.security).toEqual([])
  })

  // The default is folded in while the route compiles, so the generator never asks what it is.
  it('documents the default scheme when the route names none', () => {
    const router = fixtureRouter(
      '/pets',
      r => r.routes([fixtureRoute('POST', '/', 'create').authorize({ roles: ['ops'] })]),
      { defaultScheme: 'Bearer' },
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets', 'post')?.security).toEqual([{ Bearer: [] }])
  })

  it('records roles in the description, since an http scheme has no scopes', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('POST', '/', 'create').authorize({ schemes: ['Bearer'], roles: ['write:pets'] })]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets', 'post')?.description).toContain('write:pets')
  })

  // A scope list means every scope in it. A `roles` list means any role in it, and several lists mean one role
  // of each, so the document has to say it with alternatives or it states a stricter rule than the one enforced.
  describe('roles, where the scheme has scopes', () => {
    const flows = {
      authorizationCode: { authorizationURL: 'https://idp.test/authorize', tokenURL: 'https://idp.test/token' },
    }
    const withScopes = new Map([
      ['OAuth', { kind: 'oauth2' as const, flows }],
      ['Bearer', { kind: 'http' as const, scheme: 'bearer' }],
    ])

    const securityOf = (...declarations: Array<{ schemes?: string[]; roles?: string[]; policy?: string }>) => {
      const route = fixtureRoute('POST', '/', 'create')
      for (const declaration of declarations) {
        route.authorize(declaration)
      }

      const router = fixtureRouter('/pets', r => r.routes([route]))
      const document = generateDocument({ routeGroups: [router], options: fixtureOptions(), schemes: withScopes })

      return operationAt(document, '/pets', 'post')
    }

    it('offers each role of one list as an alternative, not all of them at once', () => {
      const operation = securityOf({ schemes: ['OAuth'], roles: ['admin', 'manager'] })

      expect(operation?.security).toEqual([{ OAuth: ['admin'] }, { OAuth: ['manager'] }])
    })

    it('asks for one role of every list when there are several', () => {
      const operation = securityOf({ schemes: ['OAuth'], roles: ['admin', 'manager'] }, { roles: ['auditor'] })

      expect(operation?.security).toEqual([{ OAuth: ['admin', 'auditor'] }, { OAuth: ['manager', 'auditor'] }])
      expect(operation?.description).toContain('Requires roles: (admin or manager) and (auditor).')
    })

    it('names a role once when two lists share it', () => {
      const operation = securityOf({ schemes: ['OAuth'], roles: ['admin'] }, { roles: ['admin', 'auditor'] })

      expect(operation?.security).toEqual([{ OAuth: ['admin'] }, { OAuth: ['admin', 'auditor'] }])
    })

    // A controller and a method can name the same pair in a different order, and two ways of taking one role
    // out of each then arrive at the same set. Listed twice, it reads as two distinct ways in.
    it('names a requirement once when two lists reach the same set', () => {
      const operation = securityOf({ schemes: ['OAuth'], roles: ['admin', 'manager'] }, { roles: ['manager', 'admin'] })

      expect(operation?.security).toEqual([
        { OAuth: ['admin', 'manager'] },
        { OAuth: ['admin'] },
        { OAuth: ['manager'] },
      ])
    })

    it('asks for the scheme alone when no role was named', () => {
      expect(securityOf({ schemes: ['OAuth'] })?.security).toEqual([{ OAuth: [] }])
    })

    it('keeps the roles out of a scheme that has no scopes, next to one that has', () => {
      const operation = securityOf({ schemes: ['OAuth', 'Bearer'], roles: ['admin', 'manager'] })

      expect(operation?.security).toEqual([{ OAuth: ['admin'] }, { OAuth: ['manager'] }, { Bearer: [] }])
    })

    // An empty requirement list is how the specification spells "no security". A declaration assembled by hand
    // with a roles list that has nothing in it must not turn a guarded route into a public one on paper.
    it('never documents a guarded route as public because a roles list came out empty', () => {
      const route = {
        authorization: {
          hasProtection: true,
          schemes: ['OAuth'],
          options: { allowAnonymous: false, defaultPolicy: false, policies: [], roleGroups: [[]] },
        },
      } as unknown as IRoute<unknown>

      expect(deriveSecurity(route, { OAuth: { type: 'oauth2', flows: {} } })).toEqual([{ OAuth: [] }])
    })

    it('describes one list without brackets, and the policies after the roles', () => {
      const operation = securityOf({ schemes: ['OAuth'], roles: ['admin', 'manager'], policy: 'adults-only' })

      expect(operation?.description).toContain('Requires roles: admin or manager; policy: adults-only.')
    })
  })
})

describe('decorator detail', () => {
  it('lets @Operation override the derived values', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/:id', 'get').detail('openapi', {
          summary: 'Get a pet',
          operationId: 'getPet',
          tags: ['Animals'],
          deprecated: true,
        }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const operation = operationAt(document, '/pets/{id}')

    expect(operation?.summary).toBe('Get a pet')
    expect(operation?.operationId).toBe('getPet')
    expect(operation?.tags).toEqual(['Animals'])
    expect(operation?.deprecated).toBe(true)
  })

  it('omits an operation marked hidden', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/', 'list'),
        fixtureRoute('GET', '/secret', 'secret').detail('openapi', { hidden: true }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(Object.keys(document.paths ?? {})).toEqual(['/pets'])
  })

  it('omits a route whose schema says hide: true', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/', 'list'),
        fixtureRoute('POST', '/', 'create').schema({ hide: true, body: petSchema }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(Object.keys(document.paths?.['/pets'] ?? {})).toEqual(['get'])
    expect(document.components).toBe(undefined)
  })

  it('omits a whole controller marked hidden', () => {
    const router = fixtureRouter('/internal', r => {
      r.detail('openapi', { hidden: true })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(document.paths).toEqual({})
  })

  it('emits a top-level tag from @APIGroup', () => {
    const router = fixtureRouter('/pets', r => {
      r.detail('openapi', { name: 'Pets', description: 'Browse and manage pets' })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(document.tags).toEqual([{ name: 'Pets', description: 'Browse and manage pets' }])
    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
  })

  it('merges @APIGroup responses into every route', () => {
    const router = fixtureRouter('/pets', r => {
      r.detail('openapi', { name: 'Pets', responses: { 500: { description: 'Something broke' } } })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.responses?.['500'].description).toBe('Something broke')
  })

  it('merges an authored parameter description over the derived parameter', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('GET', '/:id', 'get')
          .schema({ params: petIdParams })
          .detail('openapi', { parameters: [{ name: 'id', in: 'path', description: 'The pet ID' }] }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })
    const id = operationAt(document, '/pets/{id}')?.parameters?.find(p => p.name === 'id')

    expect(id?.description).toBe('The pet ID')
    expect(id?.schema).toMatchObject({ format: 'uuid' })
  })
})

describe('version differences', () => {
  it('drops a QUERY route from a 3.1.1 document and warns', () => {
    const warnings: string[] = []
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('QUERY', '/', 'search')]))

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({ version: '3.1.1' }),
      onWarning: message => warnings.push(message),
    })

    expect(document.paths?.['/pets']).toEqual({})
    expect(warnings[0]).toContain('cannot represent the "QUERY" method')
  })

  it('emits a QUERY route under additionalOperations in 3.2.0', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('QUERY', '/', 'search')]))

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions({ version: '3.2.0' }) })

    expect(document.openapi).toBe('3.2.0')
    expect(document.paths?.['/pets'].additionalOperations?.QUERY?.operationId).toBe('Fixture_search')
  })
})

describe('document-level facts', () => {
  // The generator runs without a warning sink when called directly, and must still drop what it cannot represent.
  it('drops an unrepresentable route without a warning sink', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('QUERY', '/', 'search')]))

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions({ version: '3.1.1' }) })

    expect(document.paths?.['/pets']).toEqual({})
  })

  it('emits the declared security, external docs and tags, keeping a declared tag over the derived one', () => {
    const router = fixtureRouter('/pets', r => {
      r.detail('openapi', { name: 'Pets', description: 'Derived' })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({
        security: [{ Bearer: [] }],
        externalDocs: { url: 'https://docs.example.com' },
        tags: [{ name: 'Pets', description: 'Declared' }],
      }),
    })

    expect(document.security).toEqual([{ Bearer: [] }])
    expect(document.externalDocs).toEqual({ url: 'https://docs.example.com' })
    expect(document.tags).toEqual([{ name: 'Pets', description: 'Declared' }])
  })

  // `summary` on a tag is 3.2-only; emitting it under 3.1 makes the document invalid.
  it('carries a tag summary only under 3.2.0, and its external docs under both', () => {
    const router = (version: '3.1.1' | '3.2.0') =>
      generateDocument({
        routeGroups: [
          fixtureRouter('/pets', r => {
            r.detail('openapi', { name: 'Pets', summary: 'Pets', externalDocs: { url: 'https://pets.example' } })
            r.routes([fixtureRoute('GET', '/', 'list')])
          }),
        ],
        options: fixtureOptions({ version }),
      }).tags

    expect(router('3.1.1')).toEqual([{ name: 'Pets', externalDocs: { url: 'https://pets.example' } }])
    expect(router('3.2.0')).toEqual([{ name: 'Pets', summary: 'Pets', externalDocs: { url: 'https://pets.example' } }])
  })

  // Supplied components win, but a supplied block merges with the generated one instead of erasing it.
  it('merges supplied components over the generated ones, block by block', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([fixtureRoute('GET', '/', 'list').schema({ response: { 200: petSchema } })]),
    )

    const document = generateDocument({
      routeGroups: [router],
      options: fixtureOptions({
        components: {
          schemas: { Extra: { type: 'string' } },
          examples: { Rex: { value: { id: '1', name: 'Rex' } } },
        },
      }),
    })

    expect(Object.keys(document.components?.schemas ?? {})).toEqual(['Pet', 'Extra'])
    expect(document.components?.examples).toEqual({ Rex: { value: { id: '1', name: 'Rex' } } })
  })
})

describe('operation detail', () => {
  it('carries external docs and servers from @Operation, else servers from @APIGroup', () => {
    const router = fixtureRouter('/pets', r => {
      r.detail('openapi', { name: 'Pets', servers: [{ url: 'https://group.example' }] })
      r.routes([
        fixtureRoute('GET', '/', 'list').detail('openapi', {
          externalDocs: { url: 'https://list.example' },
          servers: [{ url: 'https://route.example' }],
        }),
        fixtureRoute('GET', '/:id', 'get').parameters([$p.param('id')]),
      ])
    })

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.externalDocs).toEqual({ url: 'https://list.example' })
    expect(operationAt(document, '/pets')?.servers).toEqual([{ url: 'https://route.example' }])
    expect(operationAt(document, '/pets/{id}')?.servers).toEqual([{ url: 'https://group.example' }])
  })

  it('merges an authored request body over the derived one, media type by media type', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('POST', '/', 'create')
          .schema({ body: petSchema })
          .detail('openapi', {
            requestBody: {
              description: 'The pet to add',
              content: { 'application/xml': { schema: { type: 'string' } } },
            },
          }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets', 'post')?.requestBody).toEqual({
      required: true,
      description: 'The pet to add',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
        'application/xml': { schema: { type: 'string' } },
      },
    })
  })

  // Roles have no OpenAPI representation on an http scheme, so the description is where a reader learns of them.
  it('appends the authorization note to an authored description', () => {
    const router = fixtureRouter('/pets', r =>
      r.routes([
        fixtureRoute('DELETE', '/:id', 'remove')
          .parameters([$p.param('id')])
          .authorize({ roles: ['admin'] })
          .detail('openapi', { description: 'Removes a pet.' }),
        fixtureRoute('POST', '/', 'create').detail('openapi', { description: 'Adds a pet.' }),
      ]),
    )

    const document = generateDocument({ routeGroups: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets/{id}', 'delete')?.description).toBe('Removes a pet.\n\nRequires roles: admin.')
    expect(operationAt(document, '/pets', 'post')?.description).toBe('Adds a pet.')
  })
})

describe('parameters', () => {
  function parametersOf(route: ReturnType<typeof fixtureRoute>, path: string, method = 'get') {
    const document = generateDocument({
      routeGroups: [fixtureRouter('/pets', r => r.routes([route]))],
      options: fixtureOptions(),
    })
    return operationAt(document, path, method)?.parameters ?? []
  }

  it('carries a property description and deprecation onto its parameter', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/', 'list').schema({
        querystring: $t.Object({ page: $t.Optional($t.Integer({ description: 'Page number', deprecated: true })) }),
      }),
      '/pets',
    )

    expect(parameters).toEqual([
      {
        name: 'page',
        in: 'query',
        required: false,
        description: 'Page number',
        deprecated: true,
        schema: { type: 'integer' },
      },
    ])
  })

  // A boolean subschema is legal JSON Schema; it means "anything" and becomes an open parameter.
  it('treats a boolean property schema as an open parameter', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/', 'list').schema({
        querystring: $t.Unsafe({ type: 'object', properties: { filter: true } }),
      }),
      '/pets',
    )

    expect(parameters).toEqual([{ name: 'filter', in: 'query', required: false, schema: {} }])
  })

  // A named slot is hoisted to components and referenced; its properties are no longer visible to explode.
  it('falls back to the template for a path slot that resolved to a reference', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/:id', 'get').schema({ params: $t.Object({ id: $t.String() }, { $id: 'PetParams' }) }),
      '/pets/{id}',
    )

    expect(parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }])
  })

  // A path property the template does not carry is not a path parameter, and documenting it would be invalid.
  it('drops a declared path property the template does not carry', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/', 'list').schema({ params: $t.Object({ id: $t.String() }) }),
      '/pets',
    )

    expect(parameters).toEqual([])
  })

  it('lifts a path regex onto the declared schema as a pattern', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/:id(^\\d+$)', 'get').schema({ params: $t.Object({ id: $t.String({ minLength: 1 }) }) }),
      '/pets/{id}',
    )

    expect(parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1, pattern: '\\d+' } },
    ])
  })

  it('describes a wildcard, keeping a description the schema already gave it', () => {
    const undescribed = parametersOf(fixtureRoute('GET', '/*', 'files'), '/pets/{wildcard}')
    const described = parametersOf(
      fixtureRoute('GET', '/*', 'files').schema({
        params: $t.Object({ wildcard: $t.String({ description: 'The file path' }) }),
      }),
      '/pets/{wildcard}',
    )

    expect(undescribed[0]?.description).toBe('Matches the remainder of the path')
    expect(described[0]?.description).toBe('The file path')
    expect(described[0]?.['x-caffeine-wildcard']).toBe(true)
  })

  it('never documents a credential header picked with $p.header', () => {
    const parameters = parametersOf(
      fixtureRoute('GET', '/', 'list').parameters([$p.header('authorization'), $p.header('x-trace-id'), $p.query()]),
      '/pets',
    )

    expect(parameters).toEqual([{ name: 'x-trace-id', in: 'header', required: false, schema: { type: 'string' } }])
  })

  describe('from route constraints', () => {
    function constrained(constraints: Array<[string, { value: unknown; header?: string }]>, headers?: object) {
      const router = fixtureRouter('/pets', r =>
        r.routes([
          headers === undefined
            ? fixtureRoute('GET', '/', 'list')
            : fixtureRoute('GET', '/', 'list').schema({ headers: headers as never }),
        ]),
      )
      const [route] = router.routes as IRoute<unknown>[]
      const withConstraints = { ...route!, config: new Map([[kRouteConstraints, new Map(constraints)]]) }

      const document = generateDocument({
        routeGroups: [{ ...router, routes: [withConstraints] }],
        options: fixtureOptions(),
      })
      return operationAt(document, '/pets')?.parameters ?? []
    }

    // A constraint that reads no header, or reads a credential, has nothing a client should send as a parameter.
    it('skips a constraint with no header and one reading a credential header', () => {
      expect(
        constrained([
          ['host', { value: 'example.com' }],
          ['auth', { value: 'x', header: 'Authorization' }],
        ]),
      ).toEqual([])
    })

    it('keeps the declared header schema over the one a constraint would add', () => {
      const parameters = constrained(
        [['version', { value: '1.0.0', header: 'accept-version' }]],
        $t.Object({ 'accept-version': $t.String({ description: 'API version' }) }),
      )

      expect(parameters).toEqual([
        {
          name: 'accept-version',
          in: 'header',
          required: true,
          description: 'API version',
          schema: { type: 'string' },
        },
      ])
    })
  })
})

describe('request bodies', () => {
  function bodyOf(route: ReturnType<typeof fixtureRoute>) {
    const document = generateDocument({
      routeGroups: [fixtureRouter('/pets', r => r.routes([route]))],
      options: fixtureOptions(),
    })
    return operationAt(document, '/pets', 'post')?.requestBody
  }

  // `$p.body()` proves a body exists even though nobody described its shape.
  it('documents an untyped body for $p.body() in every declared media type', () => {
    expect(bodyOf(fixtureRoute('POST', '/', 'create').parameters([$p.body()]))).toEqual({
      required: true,
      content: { 'application/json': {} },
    })
    expect(
      bodyOf(
        fixtureRoute('POST', '/', 'create')
          .consumes(['application/json', 'application/xml', 'application/json'])
          .parameters([$p.body()]),
      ),
    ).toEqual({ required: true, content: { 'application/json': {}, 'application/xml': {} } })
  })

  it('documents nothing for a route that reads no body', () => {
    expect(bodyOf(fixtureRoute('POST', '/', 'create'))).toBe(undefined)
  })

  // An unnamed picker reads whatever was sent, so no field name is knowable.
  it('documents an open object for unnamed multipart pickers, and adds it beside named files', () => {
    expect(bodyOf(fixtureRoute('POST', '/', 'create').parameters([$multipart.files()]))?.content).toEqual({
      'multipart/form-data': { schema: { type: 'object', additionalProperties: true } },
    })
    expect(
      bodyOf(fixtureRoute('POST', '/', 'create').parameters([$multipart.file('avatar'), $multipart.formData()]))
        ?.content,
    ).toEqual({
      'multipart/form-data': {
        schema: {
          type: 'object',
          properties: { avatar: { type: 'string', format: 'binary' } },
          required: ['avatar'],
          additionalProperties: true,
        },
      },
    })
  })
})

describe('responses', () => {
  function responsesOf(
    route: ReturnType<typeof fixtureRoute>,
    overrides: Parameters<typeof fixtureOptions>[0] = {},
    patch: Partial<IRoute<unknown>> = {},
  ) {
    const router = fixtureRouter('/pets', r => r.routes([route]))
    const routes = router.routes.map(compiled => ({ ...compiled, ...patch }))
    const document = generateDocument({ routeGroups: [{ ...router, routes }], options: fixtureOptions(overrides) })
    const item = document.paths?.['/pets'] as Record<string, OperationObject>
    return Object.values(item)[0]?.responses ?? {}
  }

  it('describes a status with no standard reason generically', () => {
    const responses = responsesOf(fixtureRoute('GET', '/', 'list').statusCode(299))

    expect(responses['299']?.description).toBe('Success')
  })

  // `@Header` promises a response header; the document must say so on the declared schema's status too.
  it('keeps the success headers on a declared success schema, leaving content-type to the content map', () => {
    // Set on the compiled route, as the adapter folds `@Header` into it; the fixture builds routes without any.
    const responses = responsesOf(
      fixtureRoute('GET', '/', 'list').schema({ response: { 200: petSchema } }),
      {},
      {
        header: new Map([
          ['cache-control', 'no-store'],
          ['Content-Type', 'application/json'],
        ]),
      },
    )

    expect(responses['200']).toEqual({
      description: 'OK',
      headers: { 'cache-control': { schema: { type: 'string' } } },
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
    })
  })

  it('declares no headers when content-type is the only one set', () => {
    const responses = responsesOf(
      fixtureRoute('GET', '/', 'list'),
      {},
      { header: new Map([['content-type', 'text/csv']]) },
    )

    expect(responses['200']).toEqual({ description: 'OK', content: { 'application/json': {} } })
  })

  it('emits no content for a declared 204 and names an unusual declared status generically', () => {
    const responses = responsesOf(
      fixtureRoute('DELETE', '/', 'clear').schema({ response: { 204: $t.Null(), 299: petSchema } }),
    )

    expect(responses['204']).toEqual({ description: 'No Content' })
    expect(responses['299']?.description).toBe('Response')
  })

  it('describes an inferred status with no standard reason generically', () => {
    const responses = responsesOf(
      fixtureRoute('POST', '/', 'create').schema({ body: petSchema }),
      fixtureOptions({ errors: { validation: 499, unauthorized: 401, forbidden: 403 } }),
    )

    expect(responses['499']).toEqual({ description: 'Error', content: { 'application/json': {} } })
  })

  it('adds an authored status that nothing derived, with no content of its own', () => {
    const responses = responsesOf(
      fixtureRoute('GET', '/', 'list').detail('openapi', { responses: { 599: {}, 404: { description: 'Gone' } } }),
    )

    expect(responses['599']).toEqual({ description: 'Response' })
    expect(responses['404']).toEqual({ description: 'Gone' })
  })

  // An authored description alone must not erase the content the schema derived, and authored content adds to it.
  it('merges an authored response over the derived one, keeping its content', () => {
    const responses = responsesOf(
      fixtureRoute('GET', '/', 'list')
        .schema({ response: { 200: petSchema } })
        .detail('openapi', {
          responses: { 200: { description: 'The pet' }, 400: { content: { 'text/plain': {} } } },
        }),
    )

    expect(responses['200']).toEqual({
      description: 'The pet',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
    })
    expect(responses['400']).toEqual({ description: 'Bad Request', content: { 'text/plain': {} } })
  })

  // The order a reader scans: numeric statuses, then ranges, then the catch-all.
  it('orders numeric statuses before ranges, and default last', () => {
    const responses = responsesOf(
      fixtureRoute('GET', '/', 'list').detail('openapi', {
        responses: { default: { description: 'Anything else' }, '4XX': { description: 'Client error' }, 404: {} },
      }),
    )

    expect(Object.keys(responses)).toEqual(['200', '404', '4XX', 'default'])
  })
})
