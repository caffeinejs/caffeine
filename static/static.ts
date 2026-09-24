import {
  HTTPPluginFactory,
  addRouteHook,
  exemptFromAuthentication,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
  type HTTPPluginConfigurer,
} from '@caffeinejs/http'
import fastifyStatic, { type ListRender } from '@fastify/static'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { rebaseDirectoryRedirect } from './_redirect.js'
import { StaticBuilder, kBuild } from './builder.js'
import type { ResolvedMount, ResolvedStatic, StaticMount } from './config.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/**
 * Serves static files over `@fastify/static`, as an ordinary Fastify plugin factory:
 * `.with(staticFiles(s => s.serve(root)))`. http does not depend on this package.
 *
 * Every `@fastify/static` option reaches the mount untouched, but for a `list.render` under a base path, whose
 * links get the base in front. Serving a single-page application is the application's own routing —
 * `isDocumentRequest` and `sendFile` are the two pieces it needs — rather than anything this plugin does on its
 * behalf.
 *
 * Under a base path, the redirect `@fastify/static` makes for a directory — a mount's `redirect: true`, and
 * `sendFile` or `download` from an application's route — answers with the request's base in front of its
 * `Location`. No other redirect is touched.
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
    const basePath = instance.$basePath

    // `@fastify/static` takes no route config from its caller, so an `onRoute` hook is the only way to reach
    // the routes an `anonymous` mount registers. It fires for exactly the mount being registered, since a mount
    // registers every file before its registration resolves.
    //
    // It reaches the wildcard route and the redirect beside it as well as the per-file ones, which is the whole
    // bundle when a mount serves on the default `wildcard: true`. Only the per-file routes build a config of
    // their own; the rest arrive with the one the adapter stamped, before any plugin's hook runs.
    //
    // The same hook puts the base path back into the `Location` of a mount's redirect: `@fastify/static` builds it
    // from the path the base was taken off. Added to that mount's routes alone, so a mount that does not redirect
    // pays nothing, and it rebases that one redirect alone: a sign-in challenge the gate sends from the same route
    // carries the base already.
    let exempt = false
    let rebase = false

    if (mounts.some(({ anonymous, mount }) => anonymous || redirectsUnder(mount, basePath))) {
      instance.addHook('onRoute', route => {
        if (exempt) {
          exemptFromAuthentication(route)
        }

        if (rebase) {
          addRouteHook(route as AdapterRouteOptions, 'onSend', rebaseLocation)
        }
      })
    }

    for (let i = 0; i < mounts.length; i++) {
      const { mount, anonymous } = mounts[i]!

      exempt = anonymous
      rebase = redirectsUnder(mount, basePath)
      await instance.register(fastifyStatic, {
        ...withBasePathListing(mount, basePath),
        decorateReply: i === decorating,
      })
      exempt = false
      rebase = false
    }
  }

  return fp(plugin, { name: '@caffeinejs/static' })
}

/** Whether a mount answers redirects whose `Location` lacks the application's base path. */
function redirectsUnder(mount: StaticMount, basePath: string): boolean {
  return basePath !== '' && mount.redirect === true
}

/**
 * Puts the request's base path back in front of the `Location` of a mount's redirect, which `@fastify/static` builds
 * from the path the base was taken off. A request that came without the base has none to put back.
 */
function rebaseLocation(
  request: AdapterRequest,
  reply: AdapterReply,
  payload: unknown,
  done: (err: Error | null, payload?: unknown) => void,
): void {
  const location = reply.getHeader('location')

  if (typeof location === 'string') {
    reply.header(
      'location',
      rebaseDirectoryRedirect(location, reply.statusCode, request.raw.url, request.httpContext.req.basePath),
    )
  }

  done(null, payload)
}

/**
 * The mount, with an HTML listing that renders its links under the base path. `render` is handed no request, so
 * the links get the base the application was configured with; one still routes for a request that came without it.
 */
function withBasePathListing(mount: StaticMount, basePath: string): StaticMount {
  const list = mount.list

  if (basePath === '' || typeof list !== 'object' || list.render === undefined) {
    return mount
  }

  const render: ListRender = list.render
  const rebased: ListRender = (dirs, files) =>
    render(
      dirs.map(dir => ({ ...dir, href: basePath + dir.href })),
      files.map(file => ({ ...file, href: basePath + file.href })),
    )

  return { ...mount, list: { ...list, render: rebased } }
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
