import fastifyStatic from '@fastify/static'
import { FeatureConfigurer, type ServerPhaseContext } from '@caffeinejs/http'
import { kStaticMounts } from './keys.js'
import type { StaticMount } from './static.js'

/**
 * Registers each configured static mount with `@fastify/static`; inert when none were configured.
 *
 * `@fastify/static` decorates `reply.sendFile` and throws if a second registration tries to decorate it
 * again — so only the first mount may decorate (unless a mount opts out explicitly); the rest register with
 * `decorateReply: false`.
 */
export class StaticConfigurer extends FeatureConfigurer {
  readonly name = 'static'

  configureServer = async (ctx: ServerPhaseContext): Promise<void> => {
    const mounts = ctx.container.getOptional<StaticMount[]>(kStaticMounts) ?? []

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]
      const decorateReply = i === 0 ? (mount.decorateReply ?? true) : false
      await ctx.server.register(fastifyStatic, { ...mount, decorateReply })
    }
  }
}
