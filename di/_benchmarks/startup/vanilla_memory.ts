class UserRepository {}

class OrderRepository {}

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

const userRepo = new UserRepository()
const orderRepo = new OrderRepository()
const productRepo = new ProductRepository()
const userSvc = new UserService(userRepo)
const orderSvc = new OrderService(orderRepo, userSvc)
const _app = new AppService(userSvc, orderSvc, productRepo)

global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))
