import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'

@Controller()
class AppController {
  @Get('/')
  helloWorld() {
    return { hello: 'world' }
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

const PORT = parseInt(process.env.PORT ?? '3000', 10)

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })

  await app.listen(PORT, '0.0.0.0')
}

void bootstrap()
