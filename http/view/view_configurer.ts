import fastifyView from '@fastify/view'
import { FeatureConfigurer, type ServerPhaseContext } from '../feature_configurer.js'
import { kViewOptions } from './keys.js'
import type { ViewOptions } from './view.js'

/**
 * Registers `@fastify/view` on the root server when the view feature was configured; inert otherwise.
 *
 * `@fastify/view` is `fastify-plugin`-wrapped, so registering on the root decorates `reply.view` globally —
 * it reaches the encapsulated controller `register()` contexts where routes are declared.
 */
export class ViewConfigurer extends FeatureConfigurer {
  readonly name = 'view'

  configureServer = async (ctx: ServerPhaseContext): Promise<void> => {
    const options = ctx.container.getOptional<ViewOptions>(kViewOptions)
    if (options === undefined) {
      return
    }

    await ctx.server.register(fastifyView, options)
  }
}
