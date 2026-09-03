import { Injectable } from '@caffeinejs/di'

import { CustomerService } from '../customer/customer.service.js'
import { LoggerService } from '../shared/logger.service.js'
import { AddressRepository } from './address.repository.js'

@Injectable([AddressRepository, CustomerService, LoggerService])
export class AddressService {
  constructor(
    private readonly repo: AddressRepository,
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
    this.logger.log('address.create')
    void this.customerService.findById((data as Record<string, string>).customerId)
    return this.repo.save(data)
  }

  delete(id: string): void {
    this.logger.log(`address.delete:${id}`)
    this.repo.delete(id)
  }
}
