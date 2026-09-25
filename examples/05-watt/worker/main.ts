import { createApplication } from '@caffeinejs/std'
import { HealthIndicator, type HealthReport, up } from '@caffeinejs/std/health'

import { registerWattChecks } from '../watt.js'

/** Stands in for the dependency a real worker would check: its broker, its queue. */
class QueueHealth extends HealthIndicator {
  get name(): string {
    return 'queue'
  }

  check(): HealthReport {
    return up()
  }
}

// Headless: no HTTP server, so Watt runs it as a background application (`node.hasServer: false` in its
// `watt.json`), and the checks registered below are the only view Watt's probes have of it.
const app = createApplication()
  // Nothing routes to a worker, so there is no routing table to wait for: stop consuming at once.
  .shutdown(s => s.drainDelay(0))
app.container.bind(QueueHealth, t => t.toSelf().extends(HealthIndicator))

await app.ready()
registerWattChecks(app)
await app.run()

export async function close(): Promise<void> {
  await app.close()
}
