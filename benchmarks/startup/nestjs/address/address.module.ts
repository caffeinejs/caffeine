import { Module } from '@nestjs/common'

import { CustomerModule } from '../customer/customer.module.js'
import { CustomerService } from '../customer/customer.service.js'
import { LoggerService } from '../shared/logger.service.js'
import { SharedModule } from '../shared/shared.module.js'
import { AddressController } from './address.controller.js'
import { AddressRepository } from './address.repository.js'
import { AddressService } from './address.service.js'

@Module({
  imports: [SharedModule, CustomerModule],
  providers: [
    AddressRepository,
    {
      provide: AddressService,
      useFactory: (repo: AddressRepository, customerSvc: CustomerService, logger: LoggerService) =>
        new AddressService(repo, customerSvc, logger),
      inject: [AddressRepository, CustomerService, LoggerService],
    },
    {
      provide: AddressController,
      useFactory: (svc: AddressService) => new AddressController(svc),
      inject: [AddressService],
    },
  ],
})
export class AddressModule {}
