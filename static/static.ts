import { HTTPPluginFactory, exemptFromAuthentication, type HTTPPluginConfigurer } from '@caffeinejs/http'
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { StaticBuilder, kBuild } from './builder.js'
import type { ResolvedMount, ResolvedStatic } from './config.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/**
 * Serves static files over `@fastify/static`, as an ordinary Fastify plugin factory:
 * `.with(staticFiles(s => s.serve(root)))`. http does not depend on this package.
 *
 * Every `@fastify/static` option reaches the mount untouched. Serving a single-page application is the
 * application's own routing — `isDocumentRequest` and `sendFile` are the two pieces it needs — rather than
 * anything this plugin does on its behalf.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new StaticBuilder()
    configure?.(builder, context)
    return staticPlugin(builder[kBuild]())
  }
}

function staticPlugin({ mounts }: ResolvedStatic): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    const decorating = decoratingMount(mounts)

    // `@fastify/static` takes no route config from its caller, so an `onRoute` hook is the only way to reach
    // the routes an `anonymous` mount registers. It fires for exactly the mount being registered, since a mount
    // registers every file before its registration resolves.
    //
    // It reaches the wildcard route and the redirect beside it as well as the per-file ones, which is the whole
    // bundle when a mount serves on the default `wildcard: true`. Only the per-file routes build a config of
    // their own; the rest arrive with the one the adapter stamped, before any plugin's hook runs.
    let exempt = false

    if (mounts.some(({ anonymous }) => anonymous)) {
      instance.addHook('onRoute', route => {
        if (exempt) {
          exemptFromAuthentication(route)
        }
      })
    }

    for (let i = 0; i < mounts.length; i++) {
      const { mount, anonymous } = mounts[i]!

      exempt = anonymous
      await instance.register(fastifyStatic, { ...mount, decorateReply: i === decorating })
      exempt = false
    }
  }

  return fp(plugin, { name: '@caffeinejs/static' })
}

/**
 * Which mount decorates `reply.sendFile` and `reply.download`, or `-1` when none does.
 *
 * `@fastify/static` decorates once per server, so exactly one mount may — but the application chooses which:
 * a mount that asked for it explicitly wins, and otherwise the first that did not decline. Without this the
 * decoration would always fall to the first mount, and `sendFile(ctx, ...)` would run with its settings
 * rather than the ones the application meant.
 */
function decoratingMount(mounts: readonly ResolvedMount[]): number {
  const asked = mounts.findIndex(({ mount }) => mount.decorateReply === true)

  return asked !== -1 ? asked : mounts.findIndex(({ mount }) => mount.decorateReply !== false)
}
