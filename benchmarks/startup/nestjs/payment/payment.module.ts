import { Module } from '@nestjs/common'

import { OrderModule } from '../order/order.module.js'
import { OrderService } from '../order/order.service.js'
import { NotifierService } from '../shared/notifier.service.js'
import { SharedModule } from '../shared/shared.module.js'
import { PaymentController } from './payment.controller.js'
import { PaymentRepository } from './payment.repository.js'
import { PaymentService } from './payment.service.js'

@Module({
  imports: [SharedModule, OrderModule],
  providers: [
    PaymentRepository,
    {
      provide: PaymentService,
      useFactory: (repo: PaymentRepository, orderSvc: OrderService, notifier: NotifierService) =>
        new PaymentService(repo, orderSvc, notifier),
      inject: [PaymentRepository, OrderService, NotifierService],
    },
    {
      provide: PaymentController,
      useFactory: (svc: PaymentService) => new PaymentController(svc),
      inject: [PaymentService],
    },
  ],
})
export class PaymentModule {}
