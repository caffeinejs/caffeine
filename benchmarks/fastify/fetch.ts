import fastifyFetch from '@fastify/fetch'
import Fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3031', 10)
const app = Fastify({ logger: false })

await app.register(fastifyFetch)

app.get('/health', () => ({ ok: true }))

app.fetch.post('/api/test/:text/:num/:bool', async (request, ctx) => {
  const url = new URL(request.url)
  const p = ctx.params
  const q = ctx.query
  const b = (await request.json()) as { text: string; num: number; bool: boolean }

  return Response.json({
    url: url.pathname + url.search,
    params: { text: p.text, num: p.num, bool: p.bool },
    query: { text: q.text, num: q.num, bool: q.bool },
    headers: {
      text: request.headers.get('text'),
      num: request.headers.get('num'),
      bool: request.headers.get('bool'),
    },
    body: { text: b.text, num: b.num, bool: b.bool },
  })
})

await app.ready()
await app.listen({ port: PORT, host: '0.0.0.0' })
