import { Injectable } from '@caffeinejs/di'

import { OrderService } from '../order/order.service.js'
import { NotifierService } from '../shared/notifier.service.js'
import { PaymentRepository } from './payment.repository.js'

@Injectable([PaymentRepository, OrderService, NotifierService])
export class PaymentService {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly orderService: OrderService,
    private readonly notifier: NotifierService,
  ) {}

  findAll(): unknown[] {
    return this.repo.findAll()
  }
  findById(id: string): unknown {
    return this.repo.findById(id)
  }
  process(data: unknown): unknown {
    void this.orderService.findById((data as Record<string, string>).orderId)
    const payment = this.repo.save(data)
    this.notifier.notify('payment.processed', payment)
    return payment
  }

  delete(id: string): void {
    this.repo.delete(id)
    this.notifier.notify('payment.refunded', { id })
  }
}
