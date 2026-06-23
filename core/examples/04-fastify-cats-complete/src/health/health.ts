export const HEALTH_CHECK = Symbol.for('health.check')

export interface HealthResult {
  name: string
  status: 'ok' | 'error'
  message?: string
}

export abstract class HealthCheck {
  abstract check(): Promise<HealthResult>
}
