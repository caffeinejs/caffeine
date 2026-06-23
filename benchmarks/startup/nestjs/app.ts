import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

console.time('start')
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
await app.listen(3012, '127.0.0.1')
console.timeEnd('start')
process.exit(0)
