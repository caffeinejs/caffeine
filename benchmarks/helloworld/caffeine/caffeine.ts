import { Controller, Get, newHTTP } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '@caffeinejs/http-fastify-adapter'
import fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

@Controller('')
class AppController {
  @Get('/')
  helloWorld() {
    return { hello: 'world' }
  }
}

const app = newHTTP(fastifyAdapterFactory(fastify({ logger: false })))
const adapter = await app.create()

await adapter.ready()
await adapter.listen({ port: PORT, host: '0.0.0.0' })
