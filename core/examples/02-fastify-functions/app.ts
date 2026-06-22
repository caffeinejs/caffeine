import fastify, { FastifyInstance, FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import type { Container } from '@caffeine/core'

export type ContainerPluginOptions = { container: Container }

export async function buildServer(
  opts: FastifyServerOptions = {},
  container: Container,
  ...plugins: FastifyPluginAsync<ContainerPluginOptions>[]
): Promise<{ server: FastifyInstance, container: Container }> {
  const server = fastify({ logger: false, ...opts })
  for (const plugin of plugins) {
    await plugin(server, { container })
  }

  return { server, container }
}
