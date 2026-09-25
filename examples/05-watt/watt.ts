import type { Application } from '@caffeinejs/std'
import { ApplicationHealth, type ProbeResult } from '@caffeinejs/std/health'
import { getGlobal, hasField, setCustomHealthCheck, setCustomReadinessCheck } from '@platformatic/globals'

/** What Watt reads from a check: `status`, and for a failure the status code and body its probe server answers. */
interface WattCheckResult {
  status: boolean
  statusCode?: number
  body?: string
}

/**
 * Answers Watt's readiness and liveness checks from the application's `ApplicationHealth`, so Watt's probe server
 * (`/ready`, `/status`) reports what `/readyz` and `/livez` would. Does nothing outside Watt.
 *
 * Call it once `ready()` has run — the container resolves only then — and before `run()`, so Watt sees the
 * application refusing until it actually serves. Every Watt poll lands on the same cached, coalesced evaluation
 * the HTTP probes use, so polling both never doubles the load on a dependency.
 *
 * Needs Watt 3.56 or later. An older runtime registers its global without the fields the setters look up, and there
 * this registers nothing and says so.
 */
export function registerWattChecks(app: Application): void {
  // The setters throw where Watt registered no such field: outside Watt, or under a runtime older than 3.56.
  if (!hasField('setCustomReadinessCheck') || !hasField('setCustomHealthCheck')) {
    if (getGlobal() !== undefined) {
      app.log.warn('Cannot register the Watt checks: they need Watt 3.56 or later')
    }

    return
  }

  const health = app.container.get(ApplicationHealth)

  setCustomReadinessCheck(async () => verdict('readyz', await health.readiness()))
  setCustomHealthCheck(async () => verdict('livez', await health.liveness()))
}

// Terse on purpose: Watt's probe server is unauthenticated, so the body names no dependency. And never a throw —
// Watt turns one into a 500 for the whole probe, whatever the other workers answered.
function verdict(probe: string, result: ProbeResult): WattCheckResult {
  return result.ok ? { status: true } : { status: false, statusCode: 503, body: `${probe} check failed` }
}
