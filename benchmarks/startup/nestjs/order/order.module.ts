import { Module } from '@nestjs/common'

import { CartModule } from '../cart/cart.module.js'
import { CartService } from '../cart/cart.service.js'
import { CustomerModule } from '../customer/customer.module.js'
import { CustomerService } from '../customer/customer.service.js'
import { NotifierService } from '../shared/notifier.service.js'
import { SharedModule } from '../shared/shared.module.js'
import { OrderController } from './order.controller.js'
import { OrderRepository } from './order.repository.js'
import { OrderService } from './order.service.js'

@Module({
  imports: [SharedModule, CustomerModule, CartModule],
  providers: [
    OrderRepository,
    {
      provide: OrderService,
      useFactory: (
        repo: OrderRepository,
        customerSvc: CustomerService,
        cartSvc: CartService,
        notifier: NotifierService,
      ) => new OrderService(repo, customerSvc, cartSvc, notifier),
      inject: [OrderRepository, CustomerService, CartService, NotifierService],
    },
    {
      provide: OrderController,
      useFactory: (svc: OrderService) => new OrderController(svc),
      inject: [OrderService],
    },
  ],
  exports: [OrderService],
})
export class OrderModule {}
