import { Controller, Get, createWebApplication, Params, Post, Schema, $p, fastifyAdapterFactory, FastifyContext } from '@caffeinejs/http'
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
  @Params([$p.context(), $p.param(), $p.query(), $p.body(), $p.header()])
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

const app = createWebApplication(fastifyAdapterFactory(server)).build()

// The same two hooks the `caffeine` fixture registers directly on Fastify, expressed as middlewares. The
// work is identical; the delta against that fixture is the pipeline's overhead and nothing else.
app.use((ctx, next) => {
  ctx.header('x-request-id',
    Math
      .random()
      .toString(36)
      .slice(2))
  return next()
}, 'onRequest')

app.use((ctx, next) => {
  if (ctx.req.url.startsWith('/api/') && ctx.req.header('x-api-key') !== 'benchmark') {
    return ctx.status(401).body({ error: 'Unauthorized' })
  }
  return next()
}, 'preHandler')

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
