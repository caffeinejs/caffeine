import fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const app = fastify({ logger: false })

app.get('/', () => ({ hello: 'world' }))

await app.listen({ port: PORT, host: '0.0.0.0' })
