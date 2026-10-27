import type { HTTPSetupContext } from '@caffeinejs/http'
import type { HTTPPluginFactory, RouterTypes } from '@caffeinejs/http/fastify'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { HTML_DEFAULTS, kHTMLOptions, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response on this instance starts from: `.with(html())`.
 *
 * Registering it is optional — `HTML(...)` renders on {@link HTML_DEFAULTS} without it. `fastify-plugin`
 * wrapped, so registering it on the application reaches every route group; registering it on one router
 * parameterizes that group's responses alone.
 *
 * `options` runs once, when the factory builds the plugin, and the settings it returns are read on every
 * response, so handing it a configuration node lets a deployment change them without a rebuild.
 *
 * ```ts
 * .with(html(({ config }) => config.app.html))
 * ```
 */
export function html<C = unknown>(
  options?: (context: HTTPSetupContext<C, RouterTypes>) => Partial<HTMLDefaults>,
): HTTPPluginFactory<C> {
  return context => {
    const settings = options?.(context) ?? {}
    const plugin: FastifyPluginAsync = async instance => {
      instance.decorate(kHTMLOptions, {
        get autoDoctype(): boolean {
          return settings.autoDoctype ?? HTML_DEFAULTS.autoDoctype
        },
      })
    }

    return fp(plugin, { name: '@caffeinejs/html' })
  }
}
