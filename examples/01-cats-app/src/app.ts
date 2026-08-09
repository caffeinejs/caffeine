import Fastify from 'fastify'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { Container } from '@caffeinejs/di'

export function createApp(container: Container) {
  const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
  const app = createWebApplication(fastifyAdapterFactory(fastify), { container }).build()

  return app
}
