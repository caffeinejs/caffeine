import type { HTTPPlugin } from '@caffeinejs/http'
import fastifyView from '@fastify/view'
import fp from 'fastify-plugin'

import type { ViewOptionsProvider } from './options_provider.js'

/**
 * Registers `@fastify/view` on the root server once per configured engine.
 *
 * `fastify-plugin`-wrapped, so `reply.<engine>` is decorated globally and reaches the encapsulated route
 * group contexts where routes are declared. Each registration carries a distinct `propertyName` (the default
 * engine has none, decorating `reply.view`).
 */
export function viewPlugin(provider: ViewOptionsProvider): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    await Promise.all(provider.all().map(options => instance.register(fastifyView, options)))
  }

  return fp(plugin, { name: 'view' })
}
