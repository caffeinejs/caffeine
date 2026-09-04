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
    // The scope ends when the callback settles, and `done()` returns as soon as Fastify reaches its first
    // await. Waiting for the raw response to close keeps it alive for a handler that streams.
    .addHook('onRequest', (_req, reply, done) => {
      void container.requestScopeManager.run(
        () =>
          new Promise<void>(resolve => {
            reply.raw.once('close', () => resolve())
            done()
          }),
      )
    })
    .addHook('onClose', async () => await container.dispose())

  for (const plugin of plugins) {
    await plugin(server, { container })
  }

  return server
}
