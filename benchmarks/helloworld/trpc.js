import { initTRPC } from '@trpc/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const t = initTRPC.create()
const router = t.router({
  hello: t.procedure.query(() => ({ hello: 'world' })),
})

createHTTPServer({ router }).listen(PORT, '0.0.0.0')
