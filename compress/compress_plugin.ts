import type { HTTPPlugin } from '@caffeinejs/http'
import fastifyCompress from '@fastify/compress'
import fp from 'fastify-plugin'

export type CompressOptions = NonNullable<Parameters<typeof fastifyCompress>[1]>

/**
 * Registers `@fastify/compress` on the Fastify instance so responses are compressed and encoded
 * request bodies are decompressed.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 */
export function compressPlugin(options: CompressOptions = {}): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    await instance.register(fastifyCompress, options)
  }

  return fp(plugin, { name: 'compress' })
}
