import { LoggerService } from '../shared/logger.service.js'
import { CustomerRepository } from './customer.repository.js'

export class CustomerService {
  constructor(
    private readonly repo: CustomerRepository,
    private readonly logger: LoggerService,
  ) {}

  findAll(): unknown[] {
    return this.repo.findAll()
  }
  findById(id: string): unknown {
    return this.repo.findById(id)
  }
  create(data: unknown): unknown {
    this.logger.log('customer.create')
    return this.repo.save(data)
  }

  delete(id: string): void {
    this.logger.log(`customer.delete:${id}`)
    this.repo.delete(id)
  }
}
