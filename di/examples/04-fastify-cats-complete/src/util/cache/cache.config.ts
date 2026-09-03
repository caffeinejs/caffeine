import { Configuration, OnPreDestroy, Provides } from '@caffeinejs/di'
import { Redis } from 'ioredis'

import { AppConfig } from '../../app.config.js'

@Configuration([AppConfig])
export class CacheConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(Redis)
  @OnPreDestroy((redis: Redis) => redis.quit())
  redis(): Redis {
    return new Redis(this.config.redisURL)
  }
}
