import { Controller, Get, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

@Controller('')
class AppController {
  @Get('/')
  helloWorld() {
    return { hello: 'world' }
  }
}

void [AppController]

const app = createWebApplication({ adapter: node() })

await app.run({ port: PORT, host: '0.0.0.0' })
