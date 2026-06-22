import { Pool } from 'pg'
import { Extends, Injectable } from '@caffeine/core/decorators'
import { kPgPool } from '../keys.js'
import { HealthCheck, type HealthResult } from './health.js'

@Injectable([kPgPool])
@Extends()
export class DbHealthCheck extends HealthCheck {
  constructor(private readonly pool: Pool) {
    super()
  }

  async check(): Promise<HealthResult> {
    try {
      await this.pool.query('SELECT 1')
      return { name: 'database', status: 'ok' }
    } catch (err) {
      return { name: 'database', status: 'error', message: String(err) }
    }
  }
}
