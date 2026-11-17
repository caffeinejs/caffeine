import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http/node'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const router = new Router('')
router.get('/').handler(() => ({ hello: 'world' }))

const app = createWebApplication({ adapter: node() }).mount(router)

await app.run({ port: PORT, host: '0.0.0.0' })
