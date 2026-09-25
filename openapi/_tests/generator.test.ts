import { $p, type Route } from '@caffeinejs/http'
import { $multipart } from '@caffeinejs/multipart'
import { $t } from '@caffeinejs/std/schema'
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
      r.routes([fixtureRoute('POST', '/', 'create').schema({ body: petSchema }).authorize({})]),
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
      } as unknown as Route<unknown>

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
