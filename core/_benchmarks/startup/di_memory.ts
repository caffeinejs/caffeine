import { CaffeineIoC } from '@caffeinejs/core'
import { Injectable } from '@caffeinejs/core/decorators'

@Injectable()
class UserRepository {}

@Injectable()
class OrderRepository {}

@Injectable()
class ProductRepository {}

@Injectable([UserRepository])
class UserService {
  constructor(readonly userRepo: UserRepository) {}
}

@Injectable([OrderRepository, UserService])
class OrderService {
  constructor(
    readonly orderRepo: OrderRepository,
    readonly userSvc: UserService,
  ) {}
}

@Injectable([UserService, OrderService, ProductRepository])
class AppService {
  constructor(
    readonly userSvc: UserService,
    readonly orderSvc: OrderService,
    readonly productRepo: ProductRepository,
  ) {}
}

const di = new CaffeineIoC()
await di.init()

global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))
