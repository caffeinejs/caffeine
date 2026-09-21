import { Router, createWebApplication } from '@caffeinejs/http'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const router = new Router('')
router.get('/').handler(() => ({ hello: 'world' }))

const app = createWebApplication().mount(router)

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
