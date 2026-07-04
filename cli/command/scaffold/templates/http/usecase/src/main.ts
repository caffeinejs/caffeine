import Fastify from 'fastify'
import { fastifyAdapterFactory } from '@caffeinejs/http'
import { newHTTP } from '@caffeinejs/application'
import './presentation/example.controller.js'

const app = newHTTP(fastifyAdapterFactory(Fastify({ logger: true })))
await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
