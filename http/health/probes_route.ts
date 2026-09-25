import type { ApplicationHealth, ProbeOptions, ProbeResult } from '@caffeinejs/std/health'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { solutions } from '../error/util.js'
import { authenticationExempt } from '../routing/fastify/route_config.js'
import { ErrHealthConfiguration } from './errors.js'
import type { HealthOptions } from './options.js'
import { renderProbe, type ProbeQuery } from './probes.js'

interface ProbeRequestQuery {
  verbose?: string | string[]
  exclude?: string | string[]
}

/**
 * Mounts the three probes on the root server, before any controller is registered, answering from the
 * application's {@link ApplicationHealth}.
 *
 * The probes are marked {@link authenticationExempt}, so the authentication gate does not run for them: a
 * fallback policy cannot make the kubelet see a 401, and an authentication scheme that is failing cannot make it
 * see a 500.
 */
export function installHealthProbes(server: FastifyInstance, options: HealthOptions, health: ApplicationHealth): void {
  const paths = options.paths
  assertNoCollision(server, [paths.live, paths.ready, paths.startup])

  mount(server, paths.live, 'livez', options, probe => health.liveness(probe))
  mount(server, paths.ready, 'readyz', options, probe => health.readiness(probe))
  mount(server, paths.startup, 'startupz', options, probe => health.startup(probe))
}

function mount(
  server: FastifyInstance,
  path: string,
  probe: string,
  options: HealthOptions,
  evaluate: (probe: ProbeOptions) => Promise<ProbeResult>,
): void {
  server.route({
    method: ['GET', 'HEAD'],
    url: path,
    config: authenticationExempt(),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = probeQuery(request.query as ProbeRequestQuery)

      // An unhonoured `exclude` only ever makes the check stricter, which is the safe direction to fail in. Rejecting
      // the request instead would let a caller's query string take the pod out of the routing table.
      const result = await evaluate({ exclude: options.exclude ? query.exclude : undefined })
      const response = renderProbe(probe, result, options.verbose && query.verbose === true)

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

/** Compiled routes register after the probes, so each is checked as it registers. */
function assertNoCollision(server: FastifyInstance, probePaths: readonly string[]): void {
  const taken = new Set(probePaths)

  server.addHook('onRoute', route => {
    if (route.config?.$caffeine?.compiled === undefined || !taken.has(route.url)) {
      return
    }

    throw new ErrHealthConfiguration(
      `Cannot mount health probes: a route is already registered at "${route.url}"` +
        solutions('Move the probe with health(h => h.paths({ ... }))', 'Change the conflicting route path'),
    )
  })
}
