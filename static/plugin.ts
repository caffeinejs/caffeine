import type { HTTPPluginFactory } from '@caffeinejs/http'

import { kBuild, StaticBuilder } from './builder.js'
import { staticPlugin } from './static_plugin.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer = (builder: StaticBuilder) => void

/**
 * Serves static files over `@fastify/static`, as an ordinary Fastify plugin factory:
 * `.with(staticFiles(s => s.serve(root)))`. http does not depend on this package.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer): HTTPPluginFactory<C> {
  return () => {
    const builder = new StaticBuilder()
    configure?.(builder)
    return staticPlugin(builder[kBuild]())
  }
}
