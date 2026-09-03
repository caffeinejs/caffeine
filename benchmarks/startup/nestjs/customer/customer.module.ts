import { Module } from '@nestjs/common'

import { LoggerService } from '../shared/logger.service.js'
import { SharedModule } from '../shared/shared.module.js'
import { CustomerController } from './customer.controller.js'
import { CustomerRepository } from './customer.repository.js'
import { CustomerService } from './customer.service.js'

@Module({
  imports: [SharedModule],
  providers: [
    CustomerRepository,
    {
      provide: CustomerService,
      useFactory: (repo: CustomerRepository, logger: LoggerService) => new CustomerService(repo, logger),
      inject: [CustomerRepository, LoggerService],
    },
    {
      provide: CustomerController,
      useFactory: (svc: CustomerService) => new CustomerController(svc),
      inject: [CustomerService],
    },
  ],
  exports: [CustomerService],
})
export class CustomerModule {}
