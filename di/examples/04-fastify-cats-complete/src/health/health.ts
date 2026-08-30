import { token } from '@caffeinejs/di'

export interface HealthResult {
  name: string
  status: 'ok' | 'error'
  message?: string
}

export abstract class HealthCheck {
  abstract check(): Promise<HealthResult>
}

export const HEALTH_CHECK = token<HealthCheck>(Symbol.for('health.check'))
