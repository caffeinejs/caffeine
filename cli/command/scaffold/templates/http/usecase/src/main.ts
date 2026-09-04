import { CaffeineIoC } from '@caffeinejs/di'
import { fastifyAdapterFactory, createWebApplication } from '@caffeinejs/http'
import Fastify from 'fastify'

import { rootModule } from './root.gen.mod.js'

const container = new CaffeineIoC({ modules: [rootModule] })
const app = createWebApplication(fastifyAdapterFactory(Fastify({ logger: true })), { container }).build()
await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
