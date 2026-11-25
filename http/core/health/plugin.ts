import { ApplicationHealth, type ProbeOptions, type ProbeResult } from '@caffeinejs/application/health'
import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { HTTPPlugin, type HTTPPluginConfigurer, type HTTPPluginFactory, type HTTPSetupContext } from '../../plugin.js'
import { joinPaths } from '../routing/paths.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { accessControlExempt } from '../security/exempt.js'
import { ErrHealthConfiguration } from './errors.js'
import type { HealthOptions } from './options.js'
import { renderProbe, type ProbeQuery } from './probes.js'
import { HealthProbesBuilder } from './probes_builder.js'

const PROBE: unique symbol = Symbol('caffeine.http.health-probe')

declare module '../routing/options.js' {
  interface RouteOptions {
    /** Marks the probes' own routes, so the collision check passes over them. */
    healthProbe?: typeof PROBE
  }
}

interface ProbeRequestQuery {
  verbose?: string | string[]
  exclude?: string | string[]
}

/**
 * The Kubernetes probes (`/livez`, `/readyz`, `/startupz`), answering from the application's `ApplicationHealth`:
 * `.with(healthProbes())`.
 *
 * Registering it is the opt-in for the routes — on by default from there, unless `.k8s()` gates that default on
 * `KUBERNETES_SERVICE_HOST`, or `.enabled(false)` / a configured `enabled` turns them off outright. The budgets the
 * probes answer under are the health feature's — `.install(Health(...))` — or the defaults when it was never installed.
 *
 * The probes are routes of their own that the authentication gate, the application's global guards and its
 * authorization leave alone, so the kubelet never sees a 401 or 403. Root hooks and middleware run for them. They are
 * kept out of a generated API document.
 *
 * @throws ErrHealthConfiguration at start-up when another route is registered at a probe path.
 */
export function healthProbes<C = unknown>(
  configure?: HTTPPluginConfigurer<HealthProbesBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new HealthProbesBuilder()
    configure?.(builder, context)

    return new HealthProbes(builder.resolve())
  }
}

class HealthProbes extends HTTPPlugin {
  override readonly name = 'caffeine-health-probes'
  readonly #options: HealthOptions

  constructor(options: HealthOptions) {
    super()
    this.#options = options
  }

  register(context: HTTPSetupContext): void {
    // Resolved before the `enabled` check: building the service is what rejects a non-singleton indicator, and that
    // belongs to start-up whether or not the probes are mounted.
    const health = context.container.get(ApplicationHealth)
    const options = this.#options

    if (!options.enabled) {
      return
    }

    const { live, ready, startup } = options.paths
    // Where the probes serve: under the scope's path, as what it mounts nests there, joined as a route's path is.
    const prefix = context.server.prefix
    const taken = new Set([live, ready, startup].map(path => joinPaths(prefix, path)))

    context.server.hook('onRoute', route => {
      if (!taken.has(route.url) || route.options.healthProbe === PROBE) {
        return
      }

      throw new ErrHealthConfiguration(
        errMessage(`Cannot mount health probes: a route is already registered at "${route.url}"`)
          .solutions('Move the probe with healthProbes(p => p.paths({ ... }))', 'Change the conflicting route path')
          .reference('@caffeinejs/http', ErrHealthConfiguration)
          .build(),
      )
    })

    context.server.mount(
      new Router()
        .detail('http', { internal: true })
        .config(accessControlExempt(), { healthProbe: PROBE })
        .get(live)
        .handler(probe('livez', options, p => health.liveness(p)))
        .get(ready)
        .handler(probe('readyz', options, p => health.readiness(p)))
        .get(startup)
        .handler(probe('startupz', options, p => health.startup(p))),
    )
  }
}

function probe(
  name: string,
  options: HealthOptions,
  evaluate: (probe: ProbeOptions) => Promise<ProbeResult>,
): (ctx: IContext) => Promise<string> {
  return async ctx => {
    const query = probeQuery(ctx.req.query() as ProbeRequestQuery)

    // An unhonoured `exclude` only ever makes the check stricter, which is the safe direction to fail in. Rejecting
    // the request instead would let a caller's query string take the pod out of the routing table.
    const result = await evaluate({ exclude: options.exclude ? query.exclude : undefined })
    const response = renderProbe(name, result, options.verbose && query.verbose === true)

    ctx.status(response.status).headers(response.headers)
    return response.body
  }
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
