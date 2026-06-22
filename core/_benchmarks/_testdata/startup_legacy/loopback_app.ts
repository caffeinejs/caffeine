import { injectable } from '@loopback/context'
import { inject } from '@loopback/context'
import { Context } from '@loopback/context'

@injectable()
class UserRepository {}

@injectable()
class OrderRepository {}

@injectable()
class ProductRepository {}

@injectable()
class UserService {
  constructor(@inject(UserRepository.name) readonly userRepo: UserRepository) {}
}

@injectable()
class OrderService {
  constructor(
    @inject(OrderRepository.name) readonly orderRepo: OrderRepository,
    @inject(UserService.name) readonly userSvc: UserService,
  ) {}
}

@injectable()
class AppService {
  constructor(
    @inject(UserService.name) readonly userSvc: UserService,
    @inject(OrderService.name) readonly orderSvc: OrderService,
    @inject(ProductRepository.name) readonly productRepo: ProductRepository,
  ) {}
}

export function run(): number {
  const start = performance.now()
  const ctx = new Context()
  ctx.bind(UserRepository.name).toClass(UserRepository)
  ctx.bind(OrderRepository.name).toClass(OrderRepository)
  ctx.bind(ProductRepository.name).toClass(ProductRepository)
  ctx.bind(UserService.name).toClass(UserService)
  ctx.bind(OrderService.name).toClass(OrderService)
  ctx.bind(AppService.name).toClass(AppService)
  ctx.getSync(AppService.name)
  return performance.now() - start
}
