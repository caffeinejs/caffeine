import { Injectable } from '@caffeinejs/di'

import { Cache, Logger } from './infra.js'

@Injectable([Cache, Logger])
export class UserRepository {
  constructor(
    private readonly cache: Cache,
    private readonly logger: Logger,
  ) {}

  current(): string {
    this.logger.log('current')
    return this.cache.get('greeting') ?? 'anon'
  }
}
