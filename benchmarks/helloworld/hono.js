import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const app = new Hono()

app.get('/', c => c.json({ hello: 'world' }))

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
