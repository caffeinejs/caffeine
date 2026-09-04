import Fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3030', 10)
const app = Fastify({ logger: false })

app.get('/health', () => ({ ok: true }))

app.post<{
  Params: { text: string; num: string; bool: string }
  Querystring: { text: string; num: string; bool: string }
  Body: { text: string; num: number; bool: boolean }
}>('/api/test/:text/:num/:bool', (req, reply) => {
  const p = req.params
  const q = req.query
  const h = req.headers
  const b = req.body

  reply.send({
    url: req.url,
    params: { text: p.text, num: p.num, bool: p.bool },
    query: { text: q.text, num: q.num, bool: q.bool },
    headers: { text: h.text, num: h.num, bool: h.bool },
    body: { text: b.text, num: b.num, bool: b.bool },
  })
})

await app.ready()
await app.listen({ port: PORT, host: '0.0.0.0' })
