import { serve } from '@hono/node-server'

import { app } from './app.js'

const PORT = parseInt(process.env.PORT ?? '3021', 10)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
