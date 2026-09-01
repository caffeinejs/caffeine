import fastifyCompress from '@fastify/compress'
import { ServerExtension, type ServerExtensionContext } from '@caffeinejs/http'

export type CompressOptions = NonNullable<Parameters<typeof fastifyCompress>[1]>

/**
 * Registers `@fastify/compress` on the Fastify instance so responses are compressed and encoded
 * request bodies are decompressed.
 */
export class CompressExtension extends ServerExtension {
  readonly name = 'compress'

  readonly #options: CompressOptions

  constructor(options: CompressOptions = {}) {
    super()
    this.#options = options
  }

  configure = async (ctx: ServerExtensionContext): Promise<void> => {
    await ctx.server.register(fastifyCompress, this.#options)
  }
}
