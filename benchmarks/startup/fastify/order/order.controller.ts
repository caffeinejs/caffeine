import { OrderService } from './order.service.js'

export class OrderController {
  constructor(private readonly service: OrderService) {}

  findAll(): unknown[] { return this.service.findAll() }
  findOne(id: string): unknown { return this.service.findById(id) }
  create(data: unknown): unknown { return this.service.create(data) }
  delete(id: string): void { this.service.delete(id) }
}
