import fastifyMultipart from '@fastify/multipart'
import { ServerExtension, type ServerExtensionContext } from '@caffeinejs/http'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` on the Fastify instance so upload pickers can read `req.parts()` / `req.files()`.
 */
export class MultipartExtension extends ServerExtension {
  readonly name = 'multipart'

  readonly #options: MultipartOptions

  constructor(options: MultipartOptions = {}) {
    super()
    this.#options = options
  }

  configure = async (ctx: ServerExtensionContext): Promise<void> => {
    await ctx.server.register(fastifyMultipart, this.#options)
  }
}
