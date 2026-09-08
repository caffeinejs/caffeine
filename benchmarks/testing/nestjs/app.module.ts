import { Module } from '@nestjs/common'

import { CatalogRepository, InventoryRepository, PricingService } from './catalog.js'
import { HelloController } from './hello.controller.js'
import { HelloService } from './hello.service.js'
import { AppConfig, Cache, Clock, IdGenerator, Logger, Metrics } from './infra.js'
import { UserRepository } from './user.repository.js'

@Module({
  controllers: [HelloController],
  providers: [
    AppConfig,
    Clock,
    IdGenerator,
    Logger,
    Metrics,
    Cache,
    UserRepository,
    CatalogRepository,
    InventoryRepository,
    PricingService,
    HelloService,
  ],
})
export class AppModule {}
