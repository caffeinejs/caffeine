/**
 * Passes a service probe's answer through, so a spec still skips when its service is down — except under
 * `CAFFEINE_E2E_STRICT=1`, where a service that is down fails the spec instead of skipping it.
 */
export function required(service: string, up: boolean): boolean {
  if (!up && process.env.CAFFEINE_E2E_STRICT === '1') {
    throw new Error(`Cannot run e2e: "${service}" is not reachable`)
  }

  return up
}
