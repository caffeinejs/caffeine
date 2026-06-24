import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeBigArray } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3021', 10)
const big = makeBigArray()

const app = new Hono()

app.use('*', async (c, next) => {
  c.header('x-request-id', Math.random().toString(36)
    .slice(2))
  await next()
})

app.use('/api/*', async (c, next) => {
  if (c.req.header('x-api-key') !== 'benchmark') {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
})

app.get('/health', c => c.json({ ok: true }))

const schema = z.object({
  text: z.string(),
  num: z.union([z.number(), z.string().transform(v => parseInt(v, 10))]),
  bool: z.union([z.boolean(), z.string().transform(v => v === 'true')]),
})

app.post(
  '/api/test/:text/:num/:bool',
  zValidator('param', schema),
  zValidator('query', schema),
  zValidator('header', schema),
  zValidator('json', schema),
  c => {
    const params = c.req.valid('param')
    const query = c.req.valid('query')
    const header = c.req.valid('header')
    const body = c.req.valid('json')

    c.header('text', header.text)
    c.header('num', header.num.toString())
    c.header('bool', header.bool.toString())

    return c.json({
      params: {
        text: params.text,
        num: params.num,
        bool: params.bool,
      },
      query: {
        text: query.text,
        num: query.num,
        bool: query.bool,
      },
      body: {
        text: body.text,
        num: body.num,
        bool: body.bool,
      },
      header: {
        text: header.text,
        num: header.num,
        bool: header.bool,
      },
      big,
    })
  },
)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
