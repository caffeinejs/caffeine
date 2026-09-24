import { $i, Injectable, Lifetime, Scopes, type Provider } from '@caffeinejs/di'
import { Controller, Get, createWebApplication, Args, Post, Schema, $p, FastifyContext } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'

const PORT = parseInt(process.env.PORT ?? '3030', 10)

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
    header: schema,
  }),
}

@Injectable()
class AppConfig {
  readonly name = 'benchmark'
}

@Lifetime(Scopes.REQUEST)
@Injectable([AppConfig])
class AppLogger {
  constructor(readonly config: AppConfig) {}
  log(_msg: string): void {
    /* no-op */
  }
}

@Injectable([AppConfig])
class TestRepository {
  constructor(readonly config: AppConfig) {}
  find(): unknown[] {
    return []
  }
}

@Controller('', [TestRepository, $i.provide(AppLogger)])
class AppController {
  constructor(
    readonly repo: TestRepository,
    readonly logger: Provider<AppLogger>,
  ) {}

  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @Args([$p.param(), $p.query(), $p.body(), $p.header(), $p.context()])
  @Schema({ params: schema, querystring: schema, body: schema, headers: schema, response: responseSchema })
  test(params: DataSchema, q: DataSchema, b: DataSchema, h: DataSchema, ctx: FastifyContext) {
    this.logger.get().log('request')

    ctx.header('text', h.text)
    ctx.header('num', h.num.toString())
    ctx.header('bool', h.bool.toString())

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: q.text, num: q.num, bool: q.bool },
      body: { text: b.text, num: b.num, bool: b.bool },
      header: { text: h.text, num: h.num, bool: h.bool },
    }
  }
}

void [AppController]

const app = createWebApplication().serverCallback((_context, server) => {
  server.addHook('onRequest', (_req, reply, done) => {
    reply.header('x-request-id', Math.random().toString(36).slice(2))
    done()
  })

  server.addHook('preHandler', (req, reply, done) => {
    if (req.url.startsWith('/api/') && req.headers['x-api-key'] !== 'benchmark') {
      reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    done()
  })
})

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
