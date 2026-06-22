import { Redis } from 'ioredis'
import { Extends, Injectable } from '@caffeine/core/decorators'
import { HealthCheck, type HealthResult } from './health.js'

@Injectable([Redis])
@Extends()
export class CacheHealthCheck extends HealthCheck {
  constructor(private readonly redis: Redis) {
    super()
  }

  async check(): Promise<HealthResult> {
    try {
      await this.redis.ping()
      return { name: 'cache', status: 'ok' }
    } catch (err) {
      return { name: 'cache', status: 'error', message: String(err) }
    }
  }
}
