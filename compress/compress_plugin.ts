import fastifyCompress from '@fastify/compress'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

export type CompressOptions = NonNullable<Parameters<typeof fastifyCompress>[1]>

/**
 * Registers `@fastify/compress` on the Fastify instance so responses are compressed and encoded
 * request bodies are decompressed.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 */
export function compressPlugin(options: CompressOptions = {}): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyCompress, options)
  }

  return fp(plugin, { name: 'compress' })
}
