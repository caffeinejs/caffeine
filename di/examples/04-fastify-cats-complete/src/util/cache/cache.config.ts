import { Configuration, OnLifecycle, Provides } from '@caffeinejs/di'
import { Redis } from 'ioredis'

import { AppConfig } from '../../app.config.js'

@Configuration([AppConfig])
export class CacheConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(Redis)
  @OnLifecycle<Redis>({ destroy: redis => redis.quit() })
  redis(): Redis {
    return new Redis(this.config.redisURL)
  }
}
