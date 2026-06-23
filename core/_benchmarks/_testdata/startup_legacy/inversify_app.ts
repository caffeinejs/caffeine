import { injectable, Container } from 'inversify'

@injectable()
class UserRepository {}

@injectable()
class OrderRepository {}

@injectable()
class ProductRepository {}

@injectable()
class UserService {
  constructor(readonly userRepo: UserRepository) {}
}

@injectable()
class OrderService {
  constructor(
    readonly orderRepo: OrderRepository,
    readonly userSvc: UserService,
  ) {}
}

@injectable()
class AppService {
  constructor(
    readonly userSvc: UserService,
    readonly orderSvc: OrderService,
    readonly productRepo: ProductRepository,
  ) {}
}

export function run(): number {
  const start = performance.now()
  const c = new Container()
  c.bind(UserRepository).toSelf()
  c.bind(OrderRepository).toSelf()
  c.bind(ProductRepository).toSelf()
  c.bind(UserService).toSelf()
  c.bind(OrderService).toSelf()
  c.bind(AppService).toSelf()
  c.get(AppService)
  return performance.now() - start
}
