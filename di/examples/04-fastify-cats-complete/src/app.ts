import fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions } from 'fastify'
import type { Container } from '@caffeinejs/di'

export type ContainerPluginOptions = { container: Container }

export async function buildServer(
  container: Container,
  opts: FastifyServerOptions = {},
  ...plugins: FastifyPluginAsync<ContainerPluginOptions>[]
): Promise<FastifyInstance> {
  const server = fastify({ logger: true, ...opts })

  server
    .addHook('onRequest', (_req, _reply, done) => { container.requestScopeManager.run(done) })
    .addHook('onClose', async () => await container.dispose())

  for (const plugin of plugins) {
    await plugin(server, { container })
  }

  return server
}
