import type { Container } from '@caffeinejs/di'
import fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions } from 'fastify'

export type ContainerPluginOptions = { container: Container }

export async function buildServer(
  container: Container,
  opts: FastifyServerOptions = {},
  ...plugins: FastifyPluginAsync<ContainerPluginOptions>[]
): Promise<FastifyInstance> {
  const server = fastify({ logger: true, ...opts })

  server
    .addHook('onRequest', (_req, _reply, done) => {
      void container.requestScopeManager.run(done)
    })
    .addHook('onClose', async () => await container.dispose())

  for (const plugin of plugins) {
    await plugin(server, { container })
  }

  return server
}
