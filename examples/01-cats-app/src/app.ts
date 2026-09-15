import { Container } from '@caffeinejs/di'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import Fastify from 'fastify'

export function createApp(container: Container) {
  const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
  const app = createWebApplication(fastifyAdapterFactory(fastify), { container })

  return app
}
