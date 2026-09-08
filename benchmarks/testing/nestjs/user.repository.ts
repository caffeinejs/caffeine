import { Injectable } from '@nestjs/common'

import { Cache, Logger } from './infra.js'

@Injectable()
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
