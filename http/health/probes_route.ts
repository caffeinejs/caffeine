import type { FastifyContextConfig, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { solutions } from '../error/util.js'
import { joinPaths } from '../internal/paths/paths.js'
import { ErrHealthConfiguration } from './errors.js'
import { kHealthRoute } from './keys.js'
import type { HealthOptions } from './options.js'
import type { ProbeEndpoint, ProbeQuery, ProbeResponse } from './probes.js'

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
export function installHealthProbes(server: FastifyInstance, options: HealthOptions, probes: ProbeEndpoint): void {
  const paths = options.paths
  assertNoCollision(server, [paths.live, paths.ready, paths.startup])

  mount(server, paths.live, query => probes.live(query))
  mount(server, paths.ready, query => probes.ready(query))
  mount(server, paths.startup, query => probes.startup(query))
}

function mount(server: FastifyInstance, path: string, handle: (query: ProbeQuery) => Promise<ProbeResponse>): void {
  server.route({
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
  const exclude =
    query.exclude === undefined
      ? undefined
      : ([] as string[])
          .concat(query.exclude)
          .flatMap(value => value.split(','))
          .map(value => value.trim())
          .filter(Boolean)

  return {
    verbose: query.verbose !== undefined && query.verbose !== 'false',
    exclude,
  }
}

function assertNoCollision(server: FastifyInstance, probePaths: readonly string[]): void {
  const taken = new Set(probePaths)

  for (const router of server.$routeGroups) {
    for (const route of router.routes) {
      const path = `${router.prefix ?? ''}${joinPaths(router.path, route.path)}`

      if (taken.has(path)) {
        throw new ErrHealthConfiguration(
          `Cannot mount health probes: a route is already registered at "${path}"` +
            solutions('Move the probe with app.health(h => h.paths({ ... }))', 'Change the conflicting route path'),
        )
      }
    }
  }
}
