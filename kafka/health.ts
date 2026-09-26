import type { Container } from '@caffeinejs/di'
import { HealthIndicator, type HealthReport } from '@caffeinejs/std/health'

import type { KafkaContainerStatus, KafkaListenerContainer } from './listener_container.js'
import { Keys } from './symbols.js'

/** The states in which an instance is considered able to consume. */
const HEALTHY: ReadonlySet<KafkaContainerStatus> = new Set<KafkaContainerStatus>([
  'running',
  // A rebalance is a normal, brief part of group membership. Reporting it as unhealthy would take every replica
  // out of the routing table at the same moment a partition moves — the exact flap readiness exists to avoid.
  'rebalancing',
])

/**
 * Reports the listener container state of each Kafka instance that enabled `health()` to the readiness probe, so
 * "ready" means the process's consumers are actually running — not just that it started, or that its port is open.
 *
 * On the readiness group only. A broker outage must never reach liveness: restarting the pod does not fix Kafka,
 * it just removes a consumer that would otherwise resume the moment the group recovers.
 */
export class KafkaHealthIndicator extends HealthIndicator {
  get name(): string {
    return 'kafka'
  }

  readonly #container: Container

  constructor(container: Container) {
    super()
    this.#container = container
  }

  check(): HealthReport {
    const engines = this.#container
      .getBindingsByLabel(Keys.KAFKA_HEALTH)
      .map(({ binding }) => this.#container.wrapBinding<KafkaListenerContainer>(binding).get())

    if (engines.length === 0) {
      return { status: 'up' }
    }

    const data: Record<string, unknown> = {}
    const stopped: string[] = []

    for (const engine of engines) {
      const status = engine.status()
      data[engine.name] = status

      if (!HEALTHY.has(status)) {
        stopped.push(`${engine.name} is ${status}`)
      }
    }

    if (stopped.length > 0) {
      return { status: 'down', detail: stopped.join(', '), data }
    }

    return { status: 'up', data }
  }
}
