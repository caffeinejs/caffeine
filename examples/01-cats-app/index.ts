import './src/__caffeine__.gen.js'
import Fastify from 'fastify'
import { createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '@caffeinejs/http'

const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
const app = createWebApplication(fastifyAdapterFactory(fastify)).build()

await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
