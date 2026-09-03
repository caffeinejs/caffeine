import { ServerExtension, type ServerExtensionContext } from '@caffeinejs/http'
import fastifyView from '@fastify/view'

import type { ViewOptionsProvider } from './options_provider.js'

/**
 * Registers `@fastify/view` on the root server once per configured engine.
 *
 * `@fastify/view` is `fastify-plugin`-wrapped, so registering on the root decorates `reply.<engine>`
 * globally — it reaches the encapsulated controller `register()` contexts where routes are declared. Each
 * registration carries a distinct `propertyName` (the default engine has none, decorating `reply.view`).
 */
export class ViewExtension extends ServerExtension {
  readonly name = 'view'

  /** The engines to register, grouped by the provider that assembled them. */
  readonly provider: ViewOptionsProvider

  constructor(provider: ViewOptionsProvider) {
    super()
    this.provider = provider
  }

  configure = async (ctx: ServerExtensionContext): Promise<void> => {
    await Promise.all(this.provider.all().map(options => ctx.server.register(fastifyView, options)))
  }
}
