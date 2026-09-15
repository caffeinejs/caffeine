import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

@Controller('')
class AppController {
  @Get('/')
  helloWorld() {
    return { hello: 'world' }
  }
}

void [AppController]

const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
