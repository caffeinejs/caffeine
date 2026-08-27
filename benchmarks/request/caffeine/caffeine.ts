import { Controller, Get, createWebApplication, Args, Post, Schema, $p, fastifyAdapterFactory, FastifyContext } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

interface DataSchema {
  text: string
  num: number
  bool: boolean
}

const schema = $t.Object({
  text: $t.String(),
  num: $t.Number(),
  bool: $t.Boolean(),
})

const responseSchema = {
  200: $t.Object({
    params: schema,
    query: schema,
    body: schema,
  }),
}

@Controller('')
class AppController {
  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @Args([$p.context(), $p.param(), $p.query(), $p.body(), $p.header()])
  @Schema({ params: schema, querystring: schema, body: schema, response: responseSchema })
  helloWorld(
    ctx: FastifyContext,
    params: DataSchema,
    query: DataSchema,
    body: DataSchema,
    header: Record<string, string>,
  ) {
    ctx.header('text', header.text)
    ctx.header('num', header.num)
    ctx.header('bool', header.bool)

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
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

const app = createWebApplication(fastifyAdapterFactory(server)).build()

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
