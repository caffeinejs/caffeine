import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { OrderService } from './order.service.js'
import { ordersModule } from './orders.mod.js'
import { UserNotifier } from './user.notifier.js'
import { UserRepository } from './user.repository.js'

export const usersModule: Module = mod({
  name: 'users',
  needs: () => [ordersModule],
  provides: () => [UserRepository, UserNotifier],
  fn: container => {
    moduleFnCalls.push('users')
    container.bind(UserRepository, t => t.toSelf())
    container.bind(UserNotifier, t => t.toClass(UserNotifier, [OrderService]))
  },
})
