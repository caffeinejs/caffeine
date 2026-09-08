import { Injectable } from '@nestjs/common'

import { PricingService } from './catalog.js'
import { AppConfig, Clock, Logger, Metrics } from './infra.js'
import { UserRepository } from './user.repository.js'

@Injectable()
export class HelloService {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly pricing: PricingService,
    private readonly users: UserRepository,
  ) {}

  greet() {
    this.logger.log('greet')
    this.metrics.increment('hello')
    this.users.current()
    this.pricing.quote()
    void this.clock.now()
    return { hello: this.config.greeting }
  }
}
