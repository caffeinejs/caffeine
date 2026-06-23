import { CustomerService } from '../customer/customer.service.js'
import { CartService } from '../cart/cart.service.js'
import { NotifierService } from '../shared/notifier.service.js'
import { OrderRepository } from './order.repository.js'

export class OrderService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly customerService: CustomerService,
    private readonly cartService: CartService,
    private readonly notifier: NotifierService,
  ) {}

  findAll(): unknown[] { return this.repo.findAll() }
  findById(id: string): unknown { return this.repo.findById(id) }
  create(data: unknown): unknown {
    void this.customerService.findById((data as Record<string, string>).customerId)
    void this.cartService.findById((data as Record<string, string>).cartId)
    const order = this.repo.save(data)
    this.notifier.notify('order.created', order)
    return order
  }

  delete(id: string): void {
    this.repo.delete(id)
    this.notifier.notify('order.deleted', { id })
  }
}
