import { Module } from '@nestjs/common'

import { CustomerModule } from '../customer/customer.module.js'
import { CustomerService } from '../customer/customer.service.js'
import { LoggerService } from '../shared/logger.service.js'
import { SharedModule } from '../shared/shared.module.js'
import { CartController } from './cart.controller.js'
import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'

@Module({
  imports: [SharedModule, CustomerModule],
  providers: [
    CartRepository,
    {
      provide: CartService,
      useFactory: (repo: CartRepository, customerSvc: CustomerService, logger: LoggerService) =>
        new CartService(repo, customerSvc, logger),
      inject: [CartRepository, CustomerService, LoggerService],
    },
    {
      provide: CartController,
      useFactory: (svc: CartService) => new CartController(svc),
      inject: [CartService],
    },
  ],
  exports: [CartService],
})
export class CartModule {}
