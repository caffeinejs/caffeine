import type { HTTPPlugin } from '@caffeinejs/http'
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
 * .extend(c => htmlPlugin(c.app.html))
 * ```
 */
export function htmlPlugin(defaults: Partial<HTMLDefaults> = {}): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    // Read through, not copied: the argument is usually a node of the configuration tree, and a refresh has to
    // reach a response rendered after it.
    instance.decorate(kHTMLOptions, {
      get autoDoctype(): boolean {
        return defaults.autoDoctype ?? HTML_DEFAULTS.autoDoctype
      },
    })
  }

  return fp(plugin, { name: 'html' })
}
