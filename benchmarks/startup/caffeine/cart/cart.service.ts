import { Injectable } from '@caffeinejs/di'

import { CustomerService } from '../customer/customer.service.js'
import { LoggerService } from '../shared/logger.service.js'
import { CartRepository } from './cart.repository.js'

@Injectable([CartRepository, CustomerService, LoggerService])
export class CartService {
  constructor(
    private readonly repo: CartRepository,
    private readonly customerService: CustomerService,
    private readonly logger: LoggerService,
  ) {}

  findAll(): unknown[] {
    return this.repo.findAll()
  }
  findById(id: string): unknown {
    return this.repo.findById(id)
  }
  create(data: unknown): unknown {
    this.logger.log('cart.create')
    void this.customerService.findById((data as Record<string, string>).customerId)
    return this.repo.save(data)
  }

  delete(id: string): void {
    this.logger.log(`cart.delete:${id}`)
    this.repo.delete(id)
  }
}
