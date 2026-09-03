import { fastifyAdapterFactory, createWebApplication } from '@caffeinejs/http'
import Fastify from 'fastify'

import './presentation/example.controller.js'

const app = createWebApplication(fastifyAdapterFactory(Fastify({ logger: true }))).build()
await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
