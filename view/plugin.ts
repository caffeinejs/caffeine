import { ErrConfiguration, type HTTPPluginFactory } from '@caffeinejs/http'

import { ViewBuilder } from './builder.js'
import { kBuild } from './keys.js'
import { viewPlugin } from './view_plugin.js'

/** Authors the view plugin's engines through {@link ViewBuilder}. */
export type ViewConfigurer = (builder: ViewBuilder) => void

/**
 * Server-side rendering over `@fastify/view`, as an ordinary Fastify plugin factory: `.plugin(view(...))`.
 *
 * `.engine(...)` configures the default engine (`reply.view`); `.engine(name, ...)` adds a named one
 * (`reply.<name>`). At least one engine is required — installing with none fails at `app.ready()`.
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

    // Forces every engine to assemble now, so a missing engine module fails at start-up rather than from
    // inside the plugin, by which point the adapter is already wiring routes.
    return viewPlugin(builder)
  }
}
