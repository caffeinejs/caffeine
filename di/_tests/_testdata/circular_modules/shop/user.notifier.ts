import { OrderService } from './order.service.js'

export class UserNotifier {
  constructor(readonly orders: OrderService) {}

  recentCount(userId: string): number {
    return this.orders.listForUser(userId).length
  }
}
