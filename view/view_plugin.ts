import fastifyView from '@fastify/view'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { kBuild } from './keys.js'
import type { ViewOptions } from './view.js'

/**
 * Registers `@fastify/view` on the root server once per configured engine.
 *
 * `fastify-plugin`-wrapped, so `reply.<engine>` is decorated globally and reaches the encapsulated route
 * group contexts where routes are declared. Each registration carries a distinct `propertyName` (the default
 * engine has none, decorating `reply.view`).
 */
export function viewPlugin(engines: { [kBuild](): ViewOptions[] }): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await Promise.all(engines[kBuild]().map(options => instance.register(fastifyView, options)))
  }

  return fp(plugin, { name: '@caffeinejs/view' })
}
