import { $t } from '@caffeinejs/application/schema'
import { Injectable } from '@caffeinejs/di'
import { GuardResult, Router, type Guard, type GuardInput } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const schema = $t.Object({
  text: $t.String(),
  num: $t.Number(),
  bool: $t.Boolean(),
})

// The single difference from the router benchmark: the query's `text` is a codec, so Caffeine validates the route's
// request in place of Fastify's Ajv. The codec does nothing, so what the two rows differ by is that switch alone.
const query = $t.Object({
  text: $t
    .Transform($t.String())
    .Decode(text => text)
    .Encode(text => text),
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

@Injectable()
class APIKeyGuard implements Guard {
  guard(input: GuardInput): boolean | GuardResult {
    if (input.context.req.header('x-api-key') !== 'benchmark') {
      return GuardResult.unauthenticated('Invalid API key')
    }
    return true
  }
}

const api = new Router('')
api.get('/health', () => ({ ok: true }))
api
  .post('/api/test/:text/:num/:bool')
  .guards([APIKeyGuard])
  .schema({ params: schema, querystring: query, body: schema, response: responseSchema })
  .handler(ctx => {
    const params = ctx.req.param()
    const query = ctx.req.query()
    const body = ctx.req.body()
    const header = ctx.req.header()

    ctx.header('text', header.text)
    ctx.header('num', header.num)
    ctx.header('bool', header.bool)

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
    }
  })

const app = createWebApplication().mount(api)

app.use((ctx, next) => {
  ctx.header('x-request-id', Math.random().toString(36).slice(2))
  return next()
})

await app.run({ port: PORT, host: '0.0.0.0' })
