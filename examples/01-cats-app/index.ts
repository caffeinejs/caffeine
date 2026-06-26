import './src/__caffeine__.gen.js'
import Fastify from 'fastify'
import { newHTTP } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '@caffeinejs/http-fastify-adapter'

const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
const adapter = await newHTTP(fastifyAdapterFactory(fastify)).create()

await adapter.ready()
await adapter.listen({ port: 3000, host: '0.0.0.0' })
