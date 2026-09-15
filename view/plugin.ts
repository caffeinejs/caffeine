import { ErrConfiguration, type HTTPPluginFactory } from '@caffeinejs/http'
import { fastifyView } from '@fastify/view'
import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { ViewBuilder } from './builder.js'
import { kBuild } from './keys.js'
import { ViewOptions } from './view.js'

/**
 * Authors the view plugin's engines through {@link ViewBuilder}.
 */
export type ViewConfigurer = (builder: ViewBuilder) => void

/**
 * Template-based server-side rendering over `@fastify/view`.
 *
 * `.engine(...)` configures the default engine (`reply.view`); `.engine(name, ...)` adds a named one
 * (`reply.<name>`).
 *
 * At least one engine is required — installing with none fails at `app.ready()`.
 */
export function view<C = unknown>(configure?: ViewConfigurer): HTTPPluginFactory<C> {
  return () => {
    const builder = new ViewBuilder()
    configure?.(builder)

    if (builder[kBuild]().length === 0) {
      throw new ErrConfiguration(
        'Cannot install the view plugin: no engine was configured. Call .engine(...) on the builder',
      )
    }

    return viewPlugin(builder)
  }
}

function viewPlugin(engines: { [kBuild](): ViewOptions[] }): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await Promise.all(engines[kBuild]().map(options => instance.register(fastifyView, options)))
  }

  return fp(plugin, { name: '@caffeinejs/view' })
}
