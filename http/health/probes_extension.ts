import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'

import { ServerExtension, type ServerExtensionContext } from '../server_extension.js'
import type { HealthOptions } from './options.js'
import { ProbeEndpoint } from './probes.js'
import { installHealthProbes } from './probes_route.js'

/**
 * Mounts the three probes on the root server.
 *
 * `core`, so the probes are registered before anything a package contributes — an orchestrator polling
 * `/readyz` must not be answered by a fallback that happened to register a catch-all first.
 */
export class HealthProbesExtension extends ServerExtension {
  readonly name = 'caffeine-health-probes'
  readonly [kExtensionStage]: ExtensionStage = 'core'

  readonly #options: HealthOptions

  constructor(options: HealthOptions) {
    super()
    this.#options = options
  }

  configure(ctx: ServerExtensionContext): void {
    // Resolved even when the probes are off, because resolving is what checks that every health indicator is
    // a singleton — a lifetime mistake belongs to start-up, not to the first request that reads a probe.
    const probes = ctx.container.get(ProbeEndpoint)

    if (!this.#options.enabled) {
      return
    }

    installHealthProbes(ctx, this.#options, probes)
  }
}
