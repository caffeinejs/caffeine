import { RouteBuilder } from '@caffeinejs/http'
import { ApplicationAvailability, ApplicationHealth, type ProbeResult } from '@caffeinejs/std/health'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsHealthReport, DevToolsProbe } from '../wire.js'

/**
 * The application's availability and its liveness, readiness and startup probes, `GET <path>/health`, with each
 * indicator's outcome and how long it took. An indicator's `data` is for in-process callers and is not sent.
 *
 * The probes answer from the application's `ApplicationHealth`, under the budgets the `Health()` feature sets, and
 * share its cache with the health probes. Readiness and startup fail until the application has started.
 */
export function health(): DevToolsSlice {
  return {
    id: 'health',
    routes: ({ container }) => {
      // Resolved at start-up: building the service is what refuses a non-singleton indicator.
      const health = container.get(ApplicationHealth)
      const availability = container.get(ApplicationAvailability)

      return [
        new RouteBuilder()
          .method('GET')
          .path('/')
          .handle(async (): Promise<DevToolsHealthReport> => {
            const [liveness, readiness, startup] = await Promise.all([
              health.liveness(),
              health.readiness(),
              health.startup(),
            ])

            return {
              availability: {
                live: availability.live,
                ready: availability.ready,
                started: availability.started,
                draining: availability.draining,
                livenessReason: availability.livenessReason,
                readinessReason: availability.readinessReason,
              },
              liveness: probe(liveness),
              readiness: probe(readiness),
              startup: probe(startup),
            }
          }),
      ]
    },
  }
}

function probe(result: ProbeResult): DevToolsProbe {
  return {
    ok: result.ok,
    checks: result.checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
    indicators: result.outcomes.map(({ name, status, critical, detail, durationMs }) => ({
      name,
      status,
      critical,
      detail,
      durationMs,
    })),
  }
}
