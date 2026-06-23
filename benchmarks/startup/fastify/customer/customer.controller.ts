import { CustomerService } from './customer.service.js'

export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  findAll(): unknown[] { return this.service.findAll() }
  findOne(id: string): unknown { return this.service.findById(id) }
  create(data: unknown): unknown { return this.service.create(data) }
  delete(id: string): void { this.service.delete(id) }
}
