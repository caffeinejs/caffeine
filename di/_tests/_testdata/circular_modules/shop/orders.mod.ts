import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { OrderService } from './order.service.js'
import { UserRepository } from './user.repository.js'
import { usersModule } from './users.mod.js'

export const ordersModule: Module = mod({
  name: 'orders',
  needs: () => [usersModule],
  provides: () => [OrderService],
  fn: container => {
    moduleFnCalls.push('orders')
    container.bind(OrderService, t => t.toClass(OrderService, [UserRepository]))
  },
})
