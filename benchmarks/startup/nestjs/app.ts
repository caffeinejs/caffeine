import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.js'

const started = performance.now()
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
await app.listen(3012, '127.0.0.1')
// performance.now() counts from process start, so `start` covers module loading; `bootstrap` does not.
const listening = performance.now()
process.stdout.write(`start: ${listening.toFixed(3)}ms\nbootstrap: ${(listening - started).toFixed(3)}ms\n`)
await app.close()
process.exit(0)
