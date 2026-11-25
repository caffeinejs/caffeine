import { HTTPPlugin, type HTTPPluginFactory, type HTTPSetupContext } from '@caffeinejs/http'

import type { HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response of the routes it covers starts from: `.with(html())`.
 *
 * Register it once, where it covers the routes it should: on the application it covers every route, on a router that
 * router's routes. A route or a router tunes it with `.config({ html: { autoDoctype: false } })`, which wins over the
 * plugin's setting; two `html()` over one route are not reconciled, and the outer one's value stands. A request no
 * route matched, such as one an error handler answers with a not-found page, renders with `autoDoctype: true`.
 *
 * `options` runs once, when the factory builds the plugin, and what it returns is written to each route at start-up.
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

  register({ server }: HTTPSetupContext): void {
    const settings = this.#settings

    server.hook('onRoute', route => {
      const declared = route.options.html
      route.options.html = { ...declared, autoDoctype: declared?.autoDoctype ?? settings.autoDoctype ?? true }
    })
  }
}
