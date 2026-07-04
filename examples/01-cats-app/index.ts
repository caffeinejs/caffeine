import './src/__caffeine__.gen.js'
import Fastify from 'fastify'
import { newHTTP } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '@caffeinejs/http'

const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
const app = newHTTP(fastifyAdapterFactory(fastify))

await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
