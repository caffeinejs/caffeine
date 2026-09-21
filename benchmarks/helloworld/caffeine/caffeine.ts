import { Controller, Get, createWebApplication } from '@caffeinejs/http'

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

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
