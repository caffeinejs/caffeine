import { createWebApplication, type WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { ConfigSource } from '@caffeinejs/std/config'
import type { Logger } from '@caffeinejs/std/logger'

import { DevToolsUIConfigSchema } from './config.js'
import { uiRouter } from './router.js'
import { securityHeaders } from './security.js'
import { Targets, kTargets } from './targets.js'

export interface DevToolsUIOptions {
  /**
   * Where the configuration comes from, a later source winning: the `caffeine-devtools` command reads a YAML file,
   * then the environment.
   */
  sources: readonly ConfigSource[]
  /** The UI's own logger, or `false` for none. */
  logger?: Logger | false
}

/**
 * The DevTools UI, an application of its own: `run()` it, or `bootstrap()` it and `fetch` its pages.
 *
 * ```ts
 * const ui = createDevToolsUI({ sources: [new YAMLConfigSource('devtools.yaml', { optional: false })] })
 * await ui.run()
 * ```
 *
 * @throws ErrDevToolsUIConfiguration from `bootstrap()`, for an application the configuration declares wrongly.
 */
export function createDevToolsUI(options: DevToolsUIOptions): WebApplication {
  const definition = newConfiguration(DevToolsUIConfigSchema)
    .sources(...options.sources)
    .build().config

  const app = createWebApplication({ config: definition, logger: options.logger })
    .server(({ config }) => ({ listener: { host: config.server.host, port: config.server.port } }))
    .use(securityHeaders)
    .mount(uiRouter())

  // A singleton: the configuration is checked as the container initializes, and the clients close with it.
  app.container.bind(kTargets, t =>
    t
      .toFactory(({ container }) => Targets.from(container.get(definition.configToken).applications))
      .preDestroy(targets => targets.close()),
  )

  return app as unknown as WebApplication
}
