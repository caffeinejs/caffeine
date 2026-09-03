import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import { AddressController } from './address/address.controller.js'
import { AddressRepository } from './address/address.repository.js'
import { createAddressRouter } from './address/address.router.js'
import { AddressService } from './address/address.service.js'
import { CartController } from './cart/cart.controller.js'
import { CartRepository } from './cart/cart.repository.js'
import { createCartRouter } from './cart/cart.router.js'
import { CartService } from './cart/cart.service.js'
import { CustomerController } from './customer/customer.controller.js'
import { CustomerRepository } from './customer/customer.repository.js'
import { createCustomerRouter } from './customer/customer.router.js'
import { CustomerService } from './customer/customer.service.js'
import { OrderController } from './order/order.controller.js'
import { OrderRepository } from './order/order.repository.js'
import { createOrderRouter } from './order/order.router.js'
import { OrderService } from './order/order.service.js'
import { PaymentController } from './payment/payment.controller.js'
import { PaymentRepository } from './payment/payment.repository.js'
import { createPaymentRouter } from './payment/payment.router.js'
import { PaymentService } from './payment/payment.service.js'
import { LoggerService } from './shared/logger.service.js'
import { NotifierService } from './shared/notifier.service.js'

console.time('start')

const logger = new LoggerService()
const notifier = new NotifierService(logger)

const customerRepo = new CustomerRepository()
const customerSvc = new CustomerService(customerRepo, logger)
const customerCtrl = new CustomerController(customerSvc)

const addressRepo = new AddressRepository()
const addressSvc = new AddressService(addressRepo, customerSvc, logger)
const addressCtrl = new AddressController(addressSvc)

const cartRepo = new CartRepository()
const cartSvc = new CartService(cartRepo, customerSvc, logger)
const cartCtrl = new CartController(cartSvc)

const orderRepo = new OrderRepository()
const orderSvc = new OrderService(orderRepo, customerSvc, cartSvc, notifier)
const orderCtrl = new OrderController(orderSvc)

const paymentRepo = new PaymentRepository()
const paymentSvc = new PaymentService(paymentRepo, orderSvc, notifier)
const paymentCtrl = new PaymentController(paymentSvc)

const app = new Hono()
app.route('/customers', createCustomerRouter(customerCtrl))
app.route('/addresses', createAddressRouter(addressCtrl))
app.route('/cart', createCartRouter(cartCtrl))
app.route('/orders', createOrderRouter(orderCtrl))
app.route('/payments', createPaymentRouter(paymentCtrl))

serve({ fetch: app.fetch, port: 3011, hostname: '127.0.0.1' }, () => {
  console.timeEnd('start')
  process.exit(0)
})
