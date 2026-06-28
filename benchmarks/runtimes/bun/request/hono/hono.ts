import { app } from '../../../../request/hono/app.js'

const PORT = parseInt(process.env.PORT ?? '3021', 10)

Bun.serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
