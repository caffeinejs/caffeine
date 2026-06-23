import Fastify from 'fastify'
import { makeBigArray } from './shared.js'

const PORT = parseInt(process.env.PORT ?? '3020', 10)
const big = makeBigArray()

const app = Fastify({ logger: false })

app.addHook('onRequest', (_req, reply, done) => {
  reply.header('x-request-id', Math.random().toString(36)
    .slice(2))
  done()
})

app.get('/health', () => ({ ok: true }))

app.post<{
  Params: { strParam: string, numParam: number, boolParam: boolean }
  Querystring: { strQuery: string, numQuery: number, boolQuery: boolean }
  Body: { strBody: string, numBody: number, boolBody: boolean }
}>('/api/test/:strParam/:numParam/:boolParam', {
  preHandler: (req, reply, done) => {
    if (req.headers['x-api-key'] !== 'benchmark') {
      reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    done()
  },
  schema: {
    params: {
      type: 'object',
      required: ['strParam', 'numParam', 'boolParam'],
      properties: {
        strParam: { type: 'string' },
        numParam: { type: 'number' },
        boolParam: { type: 'boolean' },
      },
    },
    querystring: {
      type: 'object',
      required: ['strQuery', 'numQuery', 'boolQuery'],
      properties: {
        strQuery: { type: 'string' },
        numQuery: { type: 'number' },
        boolQuery: { type: 'boolean' },
      },
    },
    body: {
      type: 'object',
      required: ['strBody', 'numBody', 'boolBody'],
      properties: {
        strBody: { type: 'string' },
        numBody: { type: 'number' },
        boolBody: { type: 'boolean' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          params: {
            type: 'object',
            properties: {
              str: { type: 'string' },
              num: { type: 'number' },
              bool: { type: 'boolean' },
            },
          },
          query: {
            type: 'object',
            properties: {
              str: { type: 'string' },
              num: { type: 'number' },
              bool: { type: 'boolean' },
            },
          },
          body: {
            type: 'object',
            properties: {
              str: { type: 'string' },
              num: { type: 'number' },
              bool: { type: 'boolean' },
            },
          },
          header: {
            type: 'object',
            properties: {
              str: { type: 'string' },
              num: { type: 'number' },
              bool: { type: 'boolean' },
            },
          },
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
    },
  },
}, (req, reply) => {
  const p = req.params
  const q = req.query
  const b = req.body

  reply.header('x-str-header', req.headers['x-str-header'])
  reply.header('x-num-header', req.headers['x-num-header'])
  reply.header('x-bool-header', req.headers['x-bool-header'])

  return {
    params: { str: p.strParam, num: p.numParam, bool: p.boolParam },
    query: { str: q.strQuery, num: q.numQuery, bool: q.boolQuery },
    body: { str: b.strBody, num: b.numBody, bool: b.boolBody },
    header: {
      str: req.headers['x-str-header'] as string,
      num: parseInt(req.headers['x-num-header'] as string, 10),
      bool: req.headers['x-bool-header'] === 'true',
    },
    big,
  }
})

await app.listen({ port: PORT, host: '0.0.0.0' })
