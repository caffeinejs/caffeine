import { PaymentService } from './payment.service.js'

export class PaymentController {
  constructor(private readonly service: PaymentService) {}

  findAll(): unknown[] { return this.service.findAll() }
  findOne(id: string): unknown { return this.service.findById(id) }
  process(data: unknown): unknown { return this.service.process(data) }
  delete(id: string): void { this.service.delete(id) }
}
