import 'reflect-metadata'
import { Injectable } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

@Injectable()
class UserRepository {}

@Injectable()
class OrderRepository {}

@Injectable()
class ProductRepository {}

class UserService {
  constructor(readonly userRepo: UserRepository) {}
}

class OrderService {
  constructor(
    readonly orderRepo: OrderRepository,
    readonly userSvc: UserService,
  ) {}
}

class AppService {
  constructor(
    readonly userSvc: UserService,
    readonly orderSvc: OrderService,
    readonly productRepo: ProductRepository,
  ) {}
}

@Module({
  providers: [
    UserRepository,
    OrderRepository,
    ProductRepository,
    {
      provide: UserService,
      useFactory: (r: UserRepository) => new UserService(r),
      inject: [UserRepository],
    },
    {
      provide: OrderService,
      useFactory: (r: OrderRepository, s: UserService) => new OrderService(r, s),
      inject: [OrderRepository, UserService],
    },
    {
      provide: AppService,
      useFactory: (us: UserService, os: OrderService, pr: ProductRepository) => new AppService(us, os, pr),
      inject: [UserService, OrderService, ProductRepository],
    },
  ],
})
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false })

global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))

await app.close()
