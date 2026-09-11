import type { HTTPPlugin } from '@caffeinejs/http'
import fastifyCors from '@fastify/cors'
import fp from 'fastify-plugin'

export type CorsOptions = NonNullable<Parameters<typeof fastifyCors>[1]>

/**
 * Registers `@fastify/cors` on the Fastify instance so responses and preflight OPTIONS get CORS headers.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group. Extend `cors()`
 * ahead of `.authentication(...)` when a rejected cross-origin request must still carry the headers.
 */
export function corsPlugin(options: CorsOptions = {}): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    await instance.register(fastifyCors, options)
  }

  return fp(plugin, { name: 'cors' })
}
