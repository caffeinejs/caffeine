import { node } from '@elysiajs/node'
import { Elysia } from 'elysia'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

new Elysia({ adapter: node() })
  .get('/', () => ({ hello: 'world' }))
  .listen({ port: PORT, hostname: '0.0.0.0' })
