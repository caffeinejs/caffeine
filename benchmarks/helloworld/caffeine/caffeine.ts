import { Controller, Get, newHTTP } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '@caffeinejs/http-fastify'
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

const app = newHTTP(fastifyAdapterFactory(fastify({ logger: false })))

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
