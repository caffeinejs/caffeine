import { ServerExtension, type ServerExtensionContext } from '@caffeinejs/http'
import fastifyCors from '@fastify/cors'

export type CorsOptions = NonNullable<Parameters<typeof fastifyCors>[1]>

/**
 * Registers `@fastify/cors` on the Fastify instance so responses and preflight OPTIONS get CORS headers.
 */
export class CorsExtension extends ServerExtension {
  readonly name = 'cors'

  readonly #options: CorsOptions

  constructor(options: CorsOptions = {}) {
    super()
    this.#options = options
  }

  configure = async (ctx: ServerExtensionContext): Promise<void> => {
    await ctx.server.register(fastifyCors, this.#options)
  }
}
