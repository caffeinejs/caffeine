import Fastify from 'fastify'
import { fastifyAdapterFactory } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/application'
import './presentation/example.controller.js'

const app = createWebApplication(fastifyAdapterFactory(Fastify({ logger: true }))).build()
await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
