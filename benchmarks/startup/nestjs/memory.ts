import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.js'

// Same app as app.ts, built but never listened on: measures the resident memory of the constructed
// application, not its network stack.
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
await app.init()

global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))

await app.close()
process.exit(0)
