import { ErrSchemaConversion, $t } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { compileRouteSchema } from '../schema.js'

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

  it('converts a Standard Schema response and strips the dialect marker Ajv would reject', () => {
    const compiled = compileRouteSchema({ response: { 200: z.object({ name: z.string() }) } }, 'GET /pets')
    const response = compiled?.response as Record<string, unknown>

    expect(response[200]).not.toHaveProperty('$schema')
    expect(response[200]).toMatchObject({ type: 'object', properties: { name: { type: 'string' } } })
  })

  it('throws ErrSchemaConversion naming the route and slot', () => {
    try {
      compileRouteSchema({ response: { 200: z.object({ id: z.bigint() }) } }, 'GET /pets')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaConversion)
      expect((err as ErrSchemaConversion).message).toContain('GET /pets response.200')
    }
  })

  // Caffeine validates such a request with the schema's own library, so Ajv is handed none of it.
  it('hands Fastify no request slot of a route holding a Standard Schema or a codec', () => {
    const zod = compileRouteSchema(
      { params: $t.Object({ id: $t.String() }), body: z.object({ name: z.string() }) },
      'POST /pets/:id',
    )
    const codec = compileRouteSchema(
      { querystring: $t.Object({ timeout: $t.Duration() }), response: { 200: $t.Object({ ok: $t.Boolean() }) } },
      'GET /jobs',
    )

    expect(zod).toEqual({})
    expect(Object.keys(codec ?? {})).toEqual(['response'])
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
    const compiled = compileRouteSchema(
      {
        querystring: $t.Object({ page: $t.Integer() }),
        params: $t.Object({ id: $t.String() }),
      },
      'GET /pets',
    )

    expect(compiled?.querystring).not.toHaveProperty('additionalProperties')
    expect(compiled?.params).not.toHaveProperty('additionalProperties')
  })

  it('honours an explicit choice by the author', () => {
    const compiled = compileRouteSchema(
      {
        headers: $t.Object({ authorization: $t.String() }, { additionalProperties: false }),
        body: $t.Object({ name: $t.String() }, { additionalProperties: true }),
      },
      'POST /pets',
    )

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
    const compiled = compileRouteSchema(
      {
        response: { 200: $t.Object({ id: $t.String() }), '4xx': $t.Object({ message: $t.String() }) },
      },
      'GET /pets/:id',
    )

    expect(Object.keys(compiled!.response as object)).toEqual(['200', '4xx'])
    expect((compiled!.response as Record<string, unknown>)[200]).toMatchObject({ type: 'object' })
  })

  it('leaves a file body uncompiled, since its parts are streamed and never reach request.body', () => {
    const compiled = compileRouteSchema(
      {
        params: $t.Object({ id: $t.String() }),
        body: $t.Object({ avatar: $t.File(), caption: $t.String() }),
      },
      'POST /pets/:id/images',
    )

    // An Ajv validator built from this body would answer 400 to every valid upload.
    expect(compiled?.body).toBeUndefined()
    // The other slots still validate, which is the point of leaving only `body` out.
    expect(compiled?.params).toMatchObject({ type: 'object' })
  })

  it('projects a Standard Schema response from its output side', () => {
    const compiled = compileRouteSchema({ response: { 200: z.object({ limit: z.number().default(10) }) } }, 'GET /pets')

    // On the way out a defaulted property is always there.
    expect((compiled!.response as Record<string, { required?: string[] }>)[200].required).toEqual(['limit'])
  })
})
