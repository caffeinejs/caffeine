import type { FastifyContextConfig, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerExtensionContext } from '../server_extension.js'
import { joinPaths } from '../internal/paths/paths.js'
import { solutions } from '../error/util.js'
import { ErrHealthConfiguration } from './errors.js'
import { kHealthRoute } from './keys.js'
import type { ProbeQuery, ProbeResponse } from './probes.js'

interface ProbeRequestQuery {
  verbose?: string | string[]
  exclude?: string | string[]
}

/**
 * Mounts the three probes on the root server, before any controller is registered.
 *
 * The probes stay out of the request pipeline, and that is deliberate: the adapter builds no `httpContext`
 * for a route marked with {@link kHealthRoute}, and every middleware group skips a request that has none. So
 * no authentication middleware can reach a probe, no "allow anonymous" annotation is needed, and no
 * misconfigured guard can make the kubelet see a 401.
 */
export function installHealthProbes(ctx: ServerExtensionContext): void {
  const health = ctx.services.health
  if (!health.options.enabled) {
    return
  }

  const paths = health.options.paths
  assertNoCollision(ctx, [paths.live, paths.ready, paths.startup])

  const probes = health.probes

  mount(ctx, paths.live, query => probes.live(query))
  mount(ctx, paths.ready, query => probes.ready(query))
  mount(ctx, paths.startup, query => probes.startup(query))
}

function mount(
  ctx: ServerExtensionContext,
  path: string,
  handle: (query: ProbeQuery) => Promise<ProbeResponse>,
): void {
  ctx.server.route({
    method: ['GET', 'HEAD'],
    url: path,
    // Fastify types the route config as a string-keyed bag; the marker is a symbol so it cannot collide with a
    // user's own config key.
    config: { [kHealthRoute]: true } as unknown as FastifyContextConfig,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const response = await handle(probeQuery(request.query as ProbeRequestQuery))

      return reply
        .code(response.status)
        .headers(response.headers)
        .send(request.method === 'HEAD' ? undefined : response.body)
    },
  })
}

// `?verbose` counts as true when present at all, with or without a value, matching kube-apiserver. `?exclude`
// accepts both repetition and a comma-separated list.
function probeQuery(query: ProbeRequestQuery): ProbeQuery {
  const exclude = query.exclude === undefined
    ? undefined
    : ([] as string[]).concat(query.exclude).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)

  return {
    verbose: query.verbose !== undefined && query.verbose !== 'false',
    exclude,
  }
}

function assertNoCollision(ctx: ServerExtensionContext, probePaths: readonly string[]): void {
  const taken = new Set(probePaths)

  for (const router of ctx.routers) {
    for (const route of router.routes) {
      const path = `${router.prefix ?? ''}${joinPaths(router.path, route.path)}`

      if (taken.has(path)) {
        throw new ErrHealthConfiguration(
          `Cannot mount health probes: a route is already registered at "${path}"`
          + solutions(
            'Move the probe with app.health(h => h.paths({ ... }))',
            'Change the conflicting route path',
          ),
        )
      }
    }
  }
}
