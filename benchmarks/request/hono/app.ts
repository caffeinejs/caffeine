import { Ajv } from 'ajv'
import fastJsonStringify from 'fast-json-stringify'
import { Hono } from 'hono'
import { validator } from 'hono/validator'

const fieldJsonSchema = {
  type: 'object',
  required: ['text', 'num', 'bool'],
  properties: {
    text: { type: 'string' },
    num: { type: 'number' },
    bool: { type: 'boolean' },
  },
}

const ajv = new Ajv({ coerceTypes: true })
const validateParams = ajv.compile(fieldJsonSchema)
const validateQuery = ajv.compile(fieldJsonSchema)
const validateBody = ajv.compile(fieldJsonSchema)

const fieldShape = {
  type: 'object' as const,
  properties: {
    text: { type: 'string' as const },
    num: { type: 'number' as const },
    bool: { type: 'boolean' as const },
  },
  required: ['text', 'num', 'bool'] as string[],
}

const stringify = fastJsonStringify({
  type: 'object',
  properties: {
    params: fieldShape,
    query: fieldShape,
    body: fieldShape,
  },
  required: ['params', 'query', 'body'],
})

export const app = new Hono()

app.use('*', async (c, next) => {
  c.header('x-request-id', Math.random().toString(36).slice(2))
  await next()
})

app.use('/api/*', async (c, next) => {
  if (c.req.header('x-api-key') !== 'benchmark') {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
})

app.get('/health', c => c.json({ ok: true }))

app.post(
  '/api/test/:text/:num/:bool',
  validator('param', (value, c) => {
    if (!validateParams(value)) {
      return c.json({ error: 'Bad Request' }, 400)
    }
    return value
  }),
  validator('query', (value, c) => {
    if (!validateQuery(value)) {
      return c.json({ error: 'Bad Request' }, 400)
    }
    return value
  }),
  validator('json', (value, c) => {
    if (!validateBody(value)) {
      return c.json({ error: 'Bad Request' }, 400)
    }
    return value
  }),
  c => {
    const params = c.req.valid('param')
    const query = c.req.valid('query')
    const body = c.req.valid('json')
    const header = c.req.header()

    c.header('text', header.text)
    c.header('num', header.num)
    c.header('bool', header.bool)

    return c.newResponse(
      stringify({
        params,
        query,
        body,
      }),
      200,
      { 'content-type': 'application/json' },
    )
  },
)
