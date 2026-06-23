import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { makeBigArray } from './shared.js'

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
  await next()
})

app.get('/health', c => c.json({ ok: true }))

app.post(
  '/api/test/:strParam/:numParam/:boolParam',
  validator('header', (value, c) => {
    const str = value['x-str-header']
    const num = value['x-num-header']
    const bool = value['x-bool-header']
    if (!str || !num || !bool) {
      return c.json({ error: 'Missing required headers' }, 400)
    }
    return { str, num: parseInt(num, 10), bool: bool === 'true' }
  }),
  validator('query', (value, c) => {
    const str = value['strQuery']
    const num = value['numQuery']
    const bool = value['boolQuery']
    if (!str || !num || !bool) {
      return c.json({ error: 'Missing required query params' }, 400)
    }
    return { str, num: parseInt(num, 10), bool: bool === 'true' }
  }),
  validator('json', (value, c) => {
    const v = value as Record<string, unknown>
    if (typeof v['strBody'] !== 'string' || typeof v['numBody'] !== 'number' || typeof v['boolBody'] !== 'boolean') {
      return c.json({ error: 'Invalid body' }, 400)
    }
    return { str: v['strBody'], num: v['numBody'], bool: v['boolBody'] }
  }),
  c => {
    const { strParam, numParam, boolParam } = c.req.param()
    const headerData = c.req.valid('header')
    const queryData = c.req.valid('query')
    const bodyData = c.req.valid('json')

    c.header('x-str-header', c.req.header('x-str-header'))
    c.header('x-num-header', c.req.header('x-num-header'))
    c.header('x-bool-header', c.req.header('x-bool-header'))

    return c.json({
      params: {
        str: strParam,
        num: parseInt(numParam, 10),
        bool: boolParam === 'true',
      },
      query: queryData,
      body: bodyData,
      header: headerData,
      big,
    })
  },
)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
