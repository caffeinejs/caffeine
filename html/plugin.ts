import { HTTPPlugin, type HTTPPluginFactory, type HTTPSetupContext } from '@caffeinejs/http'

import { routeSettings, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response starts from: `.with(html())`.
 *
 * Registering it is optional — `HTML(...)` renders on `HTML_DEFAULTS` without it. On the application it reaches
 * every route; on a router, that router's routes, in place of what the application set. A request no route matched,
 * such as one an error handler answers with a not-found page, renders on `HTML_DEFAULTS`. A second `html()` in one
 * slot is refused.
 *
 * `options` runs once, when the factory builds the plugin, and the settings it returns are read on every
 * response, so handing it a configuration node lets a deployment change them without a rebuild.
 *
 * ```ts
 * .with(html(({ config }) => config.app.html))
 * ```
 */
export function html<C = unknown>(
  options?: (context: HTTPSetupContext<C>) => Partial<HTMLDefaults>,
): HTTPPluginFactory<C> {
  return context => new HTMLPlugin(options?.(context) ?? {})
}

class HTMLPlugin extends HTTPPlugin {
  override readonly name = '@caffeinejs/html'
  readonly #settings: Partial<HTMLDefaults>

  constructor(settings: Partial<HTMLDefaults>) {
    super()
    this.#settings = settings
  }

  register(context: HTTPSetupContext): void {
    const settings = this.#settings

    context.app.hook('onRoute', route => {
      routeSettings.set(route, settings)
    })
  }
}
