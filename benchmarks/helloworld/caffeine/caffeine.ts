import { Controller, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

@Controller('')
class AppController {
  @Get('/')
  helloWorld() {
    return { hello: 'world' }
  }
}

void [AppController]

const app = createWebApplication()

await app.run({ port: PORT, host: '0.0.0.0' })
