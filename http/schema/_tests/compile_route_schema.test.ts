import { ErrSchemaConversion, $t } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { compileRouteSchema } from '../compile_route_schema.js'

describe('compileRouteSchema', () => {
  it('returns undefined for a route without a schema', () => {
    expect(compileRouteSchema(undefined, 'GET /pets')).toBeUndefined()
  })

  it('passes a $t schema through as plain JSON Schema', () => {
    const compiled = compileRouteSchema({ params: $t.Object({ id: $t.String() }) }, 'GET /pets/:id')

    // Round-tripped through JSON, which is what Ajv sees: the TypeBox Kind marker is a symbol and invisible.
    expect(JSON.parse(JSON.stringify(compiled?.params))).toEqual({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    })
  })

  it('converts a Standard Schema slot and strips the dialect marker Ajv would reject', () => {
    const compiled = compileRouteSchema({ body: z.object({ name: z.string() }) }, 'POST /pets')

    expect(compiled?.body).not.toHaveProperty('$schema')
    expect(compiled?.body).toMatchObject({ type: 'object', properties: { name: { type: 'string' } } })
  })

  it('throws ErrSchemaConversion naming the route and slot', () => {
    try {
      compileRouteSchema({ body: z.object({ id: z.bigint() }) }, 'POST /pets')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaConversion)
      expect((err as ErrSchemaConversion).message).toContain('POST /pets body')
    }
  })
})

describe('per-slot additionalProperties policy', () => {
  it('forces headers open, so Fastify does not strip host and content-type', () => {
    const compiled = compileRouteSchema({ headers: $t.Object({ authorization: $t.String() }) }, 'GET /pets')

    expect(compiled?.headers).toMatchObject({ additionalProperties: true })
  })

  it('closes the body, so client-invented fields never reach the handler', () => {
    const compiled = compileRouteSchema({ body: $t.Object({ name: $t.String() }) }, 'POST /pets')

    expect(compiled?.body).toMatchObject({ additionalProperties: false })
  })

  it('leaves querystring and params exactly as authored', () => {
    const compiled = compileRouteSchema({
      querystring: $t.Object({ page: $t.Integer() }),
      params: $t.Object({ id: $t.String() }),
    }, 'GET /pets')

    expect(compiled?.querystring).not.toHaveProperty('additionalProperties')
    expect(compiled?.params).not.toHaveProperty('additionalProperties')
  })

  it('honours an explicit choice by the author', () => {
    const compiled = compileRouteSchema({
      headers: $t.Object({ authorization: $t.String() }, { additionalProperties: false }),
      body: $t.Object({ name: $t.String() }, { additionalProperties: true }),
    }, 'POST /pets')

    expect(compiled?.headers).toMatchObject({ additionalProperties: false })
    expect(compiled?.body).toMatchObject({ additionalProperties: true })
  })

  it('never rewrites the authored schema, which may be shared between routes', () => {
    const Body = $t.Object({ name: $t.String() })

    compileRouteSchema({ body: Body }, 'POST /pets')

    expect(Body).not.toHaveProperty('additionalProperties')
  })

  it('leaves a non-object slot alone', () => {
    const compiled = compileRouteSchema({ body: $t.Array($t.String()) }, 'POST /pets/tags')

    expect(compiled?.body).not.toHaveProperty('additionalProperties')
  })
})

describe('response slot', () => {
  it('keeps the status-code map Fastify expects', () => {
    const compiled = compileRouteSchema({
      response: { 200: $t.Object({ id: $t.String() }), '4xx': $t.Object({ message: $t.String() }) },
    }, 'GET /pets/:id')

    expect(Object.keys(compiled?.response as object)).toEqual(['200', '4xx'])
    expect((compiled?.response as Record<string, unknown>)[200]).toMatchObject({ type: 'object' })
  })

  it('projects a Standard Schema response from its output side', () => {
    const compiled = compileRouteSchema({
      body: z.object({ limit: z.number().default(10) }),
      response: { 200: z.object({ limit: z.number().default(10) }) },
    }, 'POST /pets')

    // On the way in the client may omit a defaulted property; on the way out it is always there.
    expect(compiled?.body).not.toHaveProperty('required')
    expect((compiled?.response as Record<string, { required?: string[] }>)[200].required).toEqual(['limit'])
  })
})
