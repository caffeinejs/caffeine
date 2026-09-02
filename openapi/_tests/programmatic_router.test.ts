import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { $t } from '@caffeinejs/std'
import { Router, WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { apiGroup, operation } from '../decorators/index.js'
import { OpenAPIExt } from '../plugin.js'
import type { OpenAPIDocument, OperationObject } from '../spec/spec.js'

const petSchema = $t.Object({ id: $t.String(), name: $t.String() }, { $id: 'ProgrammaticPet' })

function operationAt(document: OpenAPIDocument, path: string, method = 'get'): OperationObject | undefined {
  return (document.paths?.[path] as Record<string, OperationObject> | undefined)?.[method]
}

describe('openapi from a programmatic router', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('documents a router through the apiGroup and operation extensions', async () => {
    const pets = new Router('/documented-pets')
      .name('DocumentedPets')
      .with(apiGroup({ name: 'Documented', description: 'Browse documented pets' }))

    pets
      .get('/:id')
      .with(operation({ summary: 'Get a pet by ID', operationId: 'getDocumentedPet' }))
      .schema({ params: $t.Object({ id: $t.String() }), response: { 200: petSchema } })
      .handler(ctx => ctx.body({ id: ctx.req.param().id, name: 'Rex' }))

    pets
      .get('/hidden')
      .with(operation({ hidden: true }))
      .handler(() => ({}))

    app = createWebApplication(fastifyAdapterFactory(fastify()), {})
      .extend(OpenAPIExt())
      .openapi(o => o.info({ title: 'Documented', version: '1.0.0' }).docs(false).public())
      .build()
      .mount(pets) as WebApplication

    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    const get = operationAt(document, '/documented-pets/{id}')
    expect(get?.operationId).toBe('getDocumentedPet')
    expect(get?.summary).toBe('Get a pet by ID')
    expect(get?.tags).toEqual(['Documented'])
    expect(document.tags).toContainEqual({ name: 'Documented', description: 'Browse documented pets' })

    // `hidden` keeps an operation out of the document, same as it does on a controller.
    expect(document.paths?.['/documented-pets/hidden']).toBeUndefined()
  })

  it('describes routes declared with a router the same way it describes a controller\'s', async () => {
    const pets = new Router('/programmatic-pets').name('ProgrammaticPets')

    pets
      .get('/')
      .name('list')
      .schema({ response: { 200: $t.Array(petSchema) } })
      .handler(() => [])

    pets
      .post('/:id')
      .schema({
        params: $t.Object({ id: $t.String() }),
        body: petSchema,
      })
      .status(201)
      .handler(ctx => ctx.body(ctx.req.body()))

    app = createWebApplication(fastifyAdapterFactory(fastify()), {})
      .extend(OpenAPIExt())
      .openapi(o => o.info({ title: 'Programmatic', version: '1.0.0' }).docs(false).public())
      .build()
      .mount(pets) as WebApplication

    await app.ready()

    const document = await (await app.fetch('/openapi.json')).json() as OpenAPIDocument

    const list = operationAt(document, '/programmatic-pets')
    expect(list?.operationId).toBe('ProgrammaticPets_list')
    expect(list?.tags).toEqual(['ProgrammaticPets'])

    // Unnamed routes are still identified, from the method and the path they answer.
    const create = operationAt(document, '/programmatic-pets/{id}', 'post')
    expect(create?.operationId).toBe('ProgrammaticPets_post_id')
    expect(create?.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    )
    expect(create?.requestBody).toBeDefined()
    expect(Object.keys(create?.responses ?? {})).toContain('201')
  })
})
