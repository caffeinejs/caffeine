import { WebApplication, type WebApplicationOptions } from '../../application.js'
import { adapterFactory, type AdapterTypes } from './adapter.js'

/**
 * Creates a web application served by Fastify.
 *
 * Features are installed with `.install(Feature(configure))` and server plugins are registered with
 * `.with(factory)`, at any point in the chain before `bootstrap()` — only `.with(...)` order matters.
 * Configuration is built separately with `newConfiguration` and passed in as `{ config }`. A plugin factory is
 * `.with(({ config }) => [fastifyCors, config.app.cors.options])`.
 *
 * ```ts
 * createWebApplication()
 *   .with(staticFiles(s => s.serve('public')))
 * ```
 */
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): WebApplication<AdapterTypes, never, never, TConfig> {
  return new WebApplication(adapterFactory(), options)
}
