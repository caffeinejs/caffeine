import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.js'

const started = performance.now()
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
await app.listen(3012, '127.0.0.1')
process.stdout.write(`start: ${(performance.now() - started).toFixed(3)}ms\n`)
await app.close()
process.exit(0)
