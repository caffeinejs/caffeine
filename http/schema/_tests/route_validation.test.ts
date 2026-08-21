import { ErrSchemaNotRepresentable, $t } from '@caffeinejs/std/schema'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  $p,
  AllowAnonymous,
  Controller,
  createWebApplication,
  fastifyAdapterFactory,
  type FastifyContext,
  Get,
  Params,
  Post,
  Schema,
} from '../../index.js'
import { compileRouteSchema } from '../compile_route_schema.js'

const CreatePet = $t.Object({
  name: $t.String({ minLength: 1 }),
  ageMonths: $t.Integer({ minimum: 0 }),
  tags: $t.Optional($t.Array($t.String())),
  note: $t.Optional($t.Nullable($t.String())),
})

const ListPetsQuery = $t.Object({
  page: $t.Integer({ minimum: 1, default: 1 }),
  goodWithKids: $t.Optional($t.Boolean()),
})

const FilterQuery = $t.Object({
  status: $t.UnionEnum(['AVAILABLE', 'PENDING']),
})

const ZodBody = z.object({ title: z.string().min(1), count: z.number().int() })

@Controller('/pets')
class PetsController {
  @Get('/')
  @AllowAnonymous()
  @Schema({ querystring: ListPetsQuery, response: { 200: $t.Object({ page: $t.Integer() }) } })
  @Params([$p.query()])
  list(query: unknown): unknown {
    return query
  }

  @Get('/filter')
  @AllowAnonymous()
  @Schema({ querystring: FilterQuery })
  @Params([$p.query()])
  filter(query: unknown): unknown {
    return query
  }

  @Post('/')
  @Schema({ body: CreatePet })
  @Params([$p.body()])
  create(body: unknown): unknown {
    return { created: body }
  }

  @Post('/zod')
  @Schema({ body: ZodBody })
  @Params([$p.body()])
  createFromZod(body: unknown): unknown {
    return { created: body }
  }

  @Get('/nullable-response')
  @AllowAnonymous()
  @Schema({ response: { 200: $t.Object({ note: $t.Nullable($t.String()) }) } })
  nullableResponse(): unknown {
    return { note: null }
  }

  @Get('/headers')
  @Schema({ headers: $t.Object({ 'x-tenant': $t.String() }) })
  @Params([$p.context()])
  headers(ctx: FastifyContext): unknown {
    return { hasHost: ctx.req.hasHeader('host'), tenant: ctx.req.header('x-tenant') }
  }
}
void PetsController

async function boot() {
  const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
  await app.ready()
  return app
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('a $t schema on a live route', () => {
  it('is accepted by Fastify, which means it compiled under Ajv', async () => {
    const app = await boot()

    expect((await app.fetch('/pets?page=2')).status).toBe(200)
  })

  it('coerces the query string and applies declared defaults', async () => {
    const app = await boot()

    expect(await (await app.fetch('/pets?page=2')).json()).toEqual({ page: 2 })
    expect(await (await app.fetch('/pets')).json()).toEqual({ page: 1 })
  })

  it('rejects a body that violates the schema', async () => {
    const app = await boot()

    const res = await app.fetch('/pets', json({ name: '', ageMonths: 1 }))

    expect(res.status).toBe(400)
  })

  it('accepts a valid body', async () => {
    const app = await boot()

    const res = await app.fetch('/pets', json({ name: 'rex', ageMonths: 12 }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: { name: 'rex', ageMonths: 12 } })
  })

  it('delivers an explicit null instead of coercing it to an empty string', async () => {
    const app = await boot()

    const res = await app.fetch('/pets', json({ name: 'rex', ageMonths: 12, note: null }))

    expect(await res.json()).toEqual({ created: { name: 'rex', ageMonths: 12, note: null } })
  })

  it('strips a body field the schema does not declare', async () => {
    const app = await boot()

    const res = await app.fetch('/pets', json({ name: 'rex', ageMonths: 12, isAdmin: true }))

    expect(await res.json()).toEqual({ created: { name: 'rex', ageMonths: 12 } })
  })

  it('serializes a null through a nullable response field', async () => {
    const app = await boot()

    expect(await (await app.fetch('/pets/nullable-response')).json()).toEqual({ note: null })
  })

  it('keeps undeclared headers reachable', async () => {
    const app = await boot()

    const res = await app.fetch('/pets/headers', { headers: { 'x-tenant': 'acme' } })

    expect(await res.json()).toEqual({ hasHost: true, tenant: 'acme' })
  })

  it('rejects a request missing a declared header', async () => {
    const app = await boot()

    expect((await app.fetch('/pets/headers')).status).toBe(400)
  })

  it('accepts a UnionEnum query member and rejects a non-member', async () => {
    const app = await boot()

    expect(await (await app.fetch('/pets/filter?status=AVAILABLE')).json()).toEqual({ status: 'AVAILABLE' })
    expect((await app.fetch('/pets/filter?status=ADOPTED')).status).toBe(400)
  })
})

describe('a Standard Schema on a live route', () => {
  it('validates through Ajv after conversion', async () => {
    const app = await boot()

    expect((await app.fetch('/pets/zod', json({ title: 'x', count: 1 }))).status).toBe(200)
    expect((await app.fetch('/pets/zod', json({ title: '', count: 1 }))).status).toBe(400)
    expect((await app.fetch('/pets/zod', json({ title: 'x', count: 1.5 }))).status).toBe(400)
  })
})

describe('an unrepresentable schema at startup', () => {
  it('throws ErrSchemaNotRepresentable instead of letting Ajv reject the route', () => {
    try {
      compileRouteSchema({ body: $t.Object({ note: $t.Undefined() }) }, 'POST /pets')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrSchemaNotRepresentable)
      const e = err as ErrSchemaNotRepresentable
      expect(e.code).toBe('ERR_SCHEMA_NOT_REPRESENTABLE')
      expect(e.message).toContain('POST /pets body')
      expect(e.message).not.toContain('must be equal to one of the allowed values')
    }
  })
})
