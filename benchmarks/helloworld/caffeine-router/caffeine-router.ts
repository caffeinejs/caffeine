import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const router = new Router('')
router.get('/').handler(() => ({ hello: 'world' }))

const app = createWebApplication().mount(router)

await app.run({ port: PORT, host: '0.0.0.0' })
