import 'reflect-metadata'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { AppModule } from './app.module.js'

export async function runOnce(): Promise<unknown> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }), {
    logger: false,
  })
  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  const result = await app.inject({ method: 'GET', url: '/hello' })
  await app.close()

  if (result.statusCode !== 200) {
    throw new Error(`nestjs: GET /hello returned ${result.statusCode}`)
  }

  return result.json()
}
