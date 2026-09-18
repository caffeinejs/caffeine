import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { HTML_DEFAULTS, kHTMLOptions, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response on this instance starts from.
 *
 * Registering it is optional — `HTML(...)` renders on {@link HTML_DEFAULTS} without it. `fastify-plugin`
 * wrapped, so registering it on the application reaches every route group; registering it on one router
 * parameterizes that group's responses alone.
 *
 * ```ts
 * .with(({ config }) => html(config.app.html))
 * ```
 */
export function html(options: Partial<HTMLDefaults> = {}): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    instance.decorate(kHTMLOptions, {
      get autoDoctype(): boolean {
        return options.autoDoctype ?? HTML_DEFAULTS.autoDoctype
      },
    })
  }

  return fp(plugin, { name: '@caffeinejs/html' })
}
