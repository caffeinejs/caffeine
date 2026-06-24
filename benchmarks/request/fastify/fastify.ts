import Fastify from 'fastify'
import { makeBigArray } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3020', 10)

const big = makeBigArray()
const app = Fastify({ logger: false })

const schema = {
  type: 'object',
  required: ['text', 'num', 'bool'],
  properties: {
    text: { type: 'string' },
    num: { type: 'number' },
    bool: { type: 'boolean' },
  },
}

app.addHook('onRequest', (_req, reply, done) => {
  reply.header('x-request-id',
    Math
      .random()
      .toString(36)
      .slice(2))
  done()
})

app.get('/health', () => ({ ok: true }))

app.post<{
  Params: { text: string, num: number, bool: boolean }
  Querystring: { text: string, num: number, bool: boolean }
  Body: { text: string, num: number, bool: boolean }
}>('/api/test/:text/:num/:bool', {
  preHandler: (req, reply, done) => {
    if (req.headers['x-api-key'] !== 'benchmark') {
      reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    done()
  },
  schema: {
    params: schema,
    querystring: schema,
    body: schema,
    response: {
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
    },
  },
}, (req, reply) => {
  const p = req.params
  const q = req.query
  const b = req.body

  reply.header('text', req.headers['text'])
  reply.header('num', req.headers['num'])
  reply.header('bool', req.headers['bool'])

  reply.send({
    params: { text: p.text, num: p.num, bool: p.bool },
    query: { text: q.text, num: q.num, bool: q.bool },
    body: { text: b.text, num: b.num, bool: b.bool },
    header: {
      text: req.headers['text'] as string,
      num: parseInt(req.headers['num'] as string, 10),
      bool: req.headers['bool'] === 'true',
    },
    big,
  })
})

await app.ready()
await app.listen({ port: PORT, host: '0.0.0.0' })
