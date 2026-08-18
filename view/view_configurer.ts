import fastifyView from '@fastify/view'
import { FeatureConfigurer, type ServerPhaseContext } from '@caffeinejs/http'
import { kViewOptionsProvider } from './keys.js'
import type { ViewOptionsProvider } from './view_options_provider.js'

/**
 * Registers `@fastify/view` on the root server once per configured engine; inert when the view feature
 * was never configured.
 *
 * `@fastify/view` is `fastify-plugin`-wrapped, so registering on the root decorates `reply.<engine>`
 * globally — it reaches the encapsulated controller `register()` contexts where routes are declared. Each
 * registration carries a distinct `propertyName` (the default engine has none, decorating `reply.view`).
 */
export class ViewConfigurer extends FeatureConfigurer {
  readonly name = 'view'

  configureServer = async (ctx: ServerPhaseContext): Promise<void> => {
    const provider = ctx.container.getOptional<ViewOptionsProvider>(kViewOptionsProvider)
    if (provider === undefined) {
      return
    }

    for (const options of provider.all()) {
      await ctx.server.register(fastifyView, options)
    }
  }
}
