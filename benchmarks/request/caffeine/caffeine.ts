import { body, context, Controller, Get, header, newHTTP, param, Params, Post, query, Schema } from '@caffeinejs/http'
import { fastifyAdapterFactory, FastifyContext } from '@caffeinejs/http-fastify-adapter'
import fastify from 'fastify'
import { makeBigArray } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const big = makeBigArray()

interface DataSchema {
  text: string
  num: number
  bool: boolean
}

const schema = {
  type: 'object',
  required: ['text', 'num', 'bool'],
  properties: {
    text: { type: 'string' },
    num: { type: 'number' },
    bool: { type: 'boolean' },
  },
}

const responseSchema = {
  200: {
    type: 'object',
    properties: {
      params: schema,
      query: schema,
      body: schema,
      header: schema,
      big: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            message: { type: 'string' },
            active: { type: 'boolean' },
            cities: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
}

@Controller('')
class AppController {
  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @Params([
    param(),
    query(),
    body(),
    header(),
    context(),
  ])
  @Schema({ params: schema, querystring: schema, body: schema, headers: schema, response: responseSchema })
  helloWorld(
    params: DataSchema,
    query: DataSchema,
    body: DataSchema,
    header: DataSchema,
    ctx: FastifyContext,
  ) {
    ctx.header('text', header.text)
    ctx.header('num', header.num.toString())
    ctx.header('bool', header.bool.toString())

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
      header: { text: header.text, num: header.num, bool: header.bool },
      big,
    }
  }
}

void [AppController]

const server = fastify({ logger: false })

server.addHook('onRequest', (req, reply, done) => {
  reply.header('x-request-id',
    Math
      .random()
      .toString(36)
      .slice(2))
  done()
})

server.addHook('preHandler', (req, reply, done) => {
  if (req.url.startsWith('/api/') && req.headers['x-api-key'] !== 'benchmark') {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
  done()
})

const app = newHTTP(fastifyAdapterFactory(server))
const adapter = await app.create()

await adapter.ready()
await adapter.listen({ port: PORT, host: '0.0.0.0' })
