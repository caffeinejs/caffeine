import { describe, expect, it } from 'vitest'
import { $p } from '@caffeinejs/http'
import { $multipart } from '@caffeinejs/multipart'
import { $t } from '@caffeinejs/std'
import { ErrOpenAPIOperationConflict } from '../errors.js'
import { generateDocument } from '../generate/generator.js'
import { kAPIGroup, kOperation } from '../decorators/keys.js'
import { kOpenAPISelf } from '../keys.js'
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
      routers: [router],
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

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
    expect(operationAt(document, '/pets')?.operationId).toBe('Pets_list')
  })

  it('applies the router prefix to the path', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/:id', 'get')]), {
      prefix: '/api',
    })

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(Object.keys(document.paths ?? {})).toEqual(['/api/pets/{id}'])
  })

  it('throws on a duplicate operationId, naming both sites', () => {
    const a = fixtureRouter('/a', r => r.routes([
      fixtureRoute('GET', '/', 'list').extras(kOperation, { operationId: 'listThings' }),
    ]), { name: 'AController' })
    const b = fixtureRouter('/b', r => r.routes([
      fixtureRoute('GET', '/', 'index').extras(kOperation, { operationId: 'listThings' }),
    ]), { name: 'BController' })

    expect(() => generateDocument({ routers: [a, b], options: fixtureOptions() }))
      .toThrow(ErrOpenAPIOperationConflict)
    expect(() => generateDocument({ routers: [a, b], options: fixtureOptions() }))
      .toThrow(/AController\.list.*BController\.index/s)
  })

  it('hoists a schema carrying $id into components and references it', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/:id', 'get').schema({ params: petIdParams, response: { 200: petSchema } }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(document.components?.schemas?.Pet).toMatchObject({ type: 'object' })
    expect(operationAt(document, '/pets/{id}')?.responses?.['200'].content?.['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Pet' })
  })

  it('explodes @Schema slots into parameters with the right required flags', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list').schema({
        querystring: $t.Object({ page: $t.Optional($t.Integer()), status: $t.String() }),
      }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const parameters = operationAt(document, '/pets')?.parameters ?? []

    expect(parameters).toContainEqual(
      expect.objectContaining({ name: 'page', in: 'query', required: false }),
    )
    expect(parameters).toContainEqual(
      expect.objectContaining({ name: 'status', in: 'query', required: true }),
    )
  })

  it('falls back to $p pickers when a slot has no schema', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/:id', 'get').parameters([$p.param('id'), $p.query('page')]),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const parameters = operationAt(document, '/pets/{id}')?.parameters ?? []

    expect(parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    )
    expect(parameters).toContainEqual(
      expect.objectContaining({ name: 'page', in: 'query', required: false }),
    )
  })

  it('marks a path parameter required even when the schema says otherwise', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/:id', 'get').schema({ params: $t.Object({ id: $t.Optional($t.String()) }) }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const id = operationAt(document, '/pets/{id}')?.parameters?.find(p => p.name === 'id')

    expect(id?.required).toBe(true)
  })

  it('never documents credential headers as parameters', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list').schema({
        headers: $t.Object({ authorization: $t.String(), 'x-trace-id': $t.Optional($t.String()) }),
      }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const names = (operationAt(document, '/pets')?.parameters ?? []).map(p => p.name)

    expect(names).not.toContain('authorization')
    expect(names).toContain('x-trace-id')
  })

  it('builds a request body from @Schema({ body })', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').schema({ body: petSchema }).statusCode(201),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const operation = operationAt(document, '/pets', 'post')

    expect(operation?.requestBody?.required).toBe(true)
    expect(operation?.requestBody?.content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Pet' })
    expect(Object.keys(operation?.responses ?? {})).toContain('201')
  })

  it('synthesizes a multipart body from file pickers', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/:id/images', 'upload').parameters([$p.param('id'), $multipart.file('file')]),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const body = operationAt(document, '/pets/{id}/images', 'post')?.requestBody

    expect(body?.content['multipart/form-data'].schema).toEqual({
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    })
  })

  it('omits a request body on a GET', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list').parameters([$p.body()]),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.requestBody).toBeUndefined()
  })

  it('emits no content for a 204', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('DELETE', '/:id', 'remove').statusCode(204),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const responses = operationAt(document, '/pets/{id}', 'delete')?.responses

    expect(responses?.['204']).toEqual({ description: 'No Content' })
  })
})

describe('response inference', () => {
  it('adds the validation status when a request slot has a schema', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').schema({ body: petSchema }),
    ]))

    const document = generateDocument({
      routers: [router],
      options: fixtureOptions({ errorSchema: errorSchema }),
    })

    expect(Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})).toContain('400')
  })

  it('honours a configured validation status', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').schema({ body: petSchema }),
    ]))

    const document = generateDocument({
      routers: [router],
      options: fixtureOptions({ errors: { validation: 422, unauthorized: 401, forbidden: 403 } }),
    })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toContain('422')
    expect(statuses).not.toContain('400')
  })

  it('adds 401 and 403 on a protected route', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').authorize({ roles: ['write:pets'] }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toContain('401')
    expect(statuses).toContain('403')
  })

  it('infers nothing when inference is off', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').schema({ body: petSchema }).authorize({}),
    ]))

    const document = generateDocument({
      routers: [router],
      options: fixtureOptions({ infer: { validation: false, auth: false } }),
    })
    const statuses = Object.keys(operationAt(document, '/pets', 'post')?.responses ?? {})

    expect(statuses).toEqual(['200'])
  })

  it('lets a declared response win over an inferred one', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').schema({
        body: petSchema,
        response: { 400: $t.Object({ detail: $t.String() }) },
      }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const declared = operationAt(document, '/pets', 'post')?.responses?.['400']

    expect(declared?.content?.['application/json'].schema).toMatchObject({
      properties: { detail: { type: 'string' } },
    })
  })

  it('normalizes a lowercase wildcard status to the spec form', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list').schema({ response: { '4xx': errorSchema } }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(Object.keys(operationAt(document, '/pets')?.responses ?? {})).toContain('4XX')
  })
})

describe('security', () => {
  const schemes = new Map([['Bearer', { kind: 'http' as const, scheme: 'bearer', bearerFormat: 'JWT' }]])

  it('derives securitySchemes from the registered authentication schemes', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list')]))

    const document = generateDocument({ routers: [router], options: fixtureOptions(), schemes })

    expect(document.components?.securitySchemes?.Bearer)
      .toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
  })

  it('emits a security requirement from @Authorize', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').authorize({ schemes: ['Bearer'] }),
    ]))

    const document = generateDocument({
      routers: [router],
      options: fixtureOptions(),
      schemes,
      defaultScheme: 'Bearer',
    })

    expect(operationAt(document, '/pets', 'post')?.security).toEqual([{ Bearer: [] }])
  })

  it('emits an empty requirement for @AllowAnonymous, opting out of the document default', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list').authorize({ allowAnonymous: true }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets')?.security).toEqual([])
  })

  it('falls back to the default scheme when the route names none', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').authorize({ roles: ['ops'] }),
    ]))

    const document = generateDocument({
      routers: [router],
      options: fixtureOptions(),
      schemes,
      defaultScheme: 'Bearer',
    })

    expect(operationAt(document, '/pets', 'post')?.security).toEqual([{ Bearer: [] }])
  })

  it('records roles in the description, since an http scheme has no scopes', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('POST', '/', 'create').authorize({ schemes: ['Bearer'], roles: ['write:pets'] }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions(), schemes })

    expect(operationAt(document, '/pets', 'post')?.description).toContain('write:pets')
  })
})

describe('decorator detail', () => {
  it('lets @Operation override the derived values', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/:id', 'get').extras(kOperation, {
        summary: 'Get a pet',
        operationId: 'getPet',
        tags: ['Animals'],
        deprecated: true,
      }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
    const operation = operationAt(document, '/pets/{id}')

    expect(operation?.summary).toBe('Get a pet')
    expect(operation?.operationId).toBe('getPet')
    expect(operation?.tags).toEqual(['Animals'])
    expect(operation?.deprecated).toBe(true)
  })

  it('omits an operation marked hidden', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/', 'list'),
      fixtureRoute('GET', '/secret', 'secret').extras(kOperation, { hidden: true }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(Object.keys(document.paths ?? {})).toEqual(['/pets'])
  })

  it('omits a whole controller marked hidden', () => {
    const router = fixtureRouter('/internal', r => {
      r.extras(kAPIGroup, { hidden: true })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(document.paths).toEqual({})
  })

  it('emits a top-level tag from @APIGroup', () => {
    const router = fixtureRouter('/pets', r => {
      r.extras(kAPIGroup, { name: 'Pets', description: 'Browse and manage pets' })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(document.tags).toEqual([{ name: 'Pets', description: 'Browse and manage pets' }])
    expect(operationAt(document, '/pets')?.tags).toEqual(['Pets'])
  })

  it('merges @APIGroup responses into every route', () => {
    const router = fixtureRouter('/pets', r => {
      r.extras(kAPIGroup, { name: 'Pets', responses: { 500: { description: 'Something broke' } } })
      r.routes([fixtureRoute('GET', '/', 'list')])
    })

    const document = generateDocument({ routers: [router], options: fixtureOptions() })

    expect(operationAt(document, '/pets')?.responses?.['500'].description).toBe('Something broke')
  })

  it('merges an authored parameter description over the derived parameter', () => {
    const router = fixtureRouter('/pets', r => r.routes([
      fixtureRoute('GET', '/:id', 'get')
        .schema({ params: petIdParams })
        .extras(kOperation, { parameters: [{ name: 'id', in: 'path', description: 'The pet ID' }] }),
    ]))

    const document = generateDocument({ routers: [router], options: fixtureOptions() })
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
      routers: [router],
      options: fixtureOptions({ version: '3.1.1' }),
      onWarning: message => warnings.push(message),
    })

    expect(document.paths?.['/pets']).toEqual({})
    expect(warnings[0]).toContain('cannot represent the "QUERY" method')
  })

  it('emits a QUERY route under additionalOperations in 3.2.0', () => {
    const router = fixtureRouter('/pets', r => r.routes([fixtureRoute('QUERY', '/', 'search')]))

    const document = generateDocument({ routers: [router], options: fixtureOptions({ version: '3.2.0' }) })

    expect(document.openapi).toBe('3.2.0')
    expect(document.paths?.['/pets'].additionalOperations?.QUERY?.operationId).toBe('Fixture_search')
  })
})

describe('self-exclusion', () => {
  it('skips the package\'s own document endpoints by default', () => {
    const self = fixtureRouter('/', r => {
      r.extras(kOpenAPISelf, true)
      r.routes([fixtureRoute('GET', '/openapi.json', 'json')])
    })
    const pets = fixtureRouter('/pets', r => r.routes([fixtureRoute('GET', '/', 'list')]))

    const document = generateDocument({ routers: [self, pets], options: fixtureOptions() })

    expect(Object.keys(document.paths ?? {})).toEqual(['/pets'])
  })
})
