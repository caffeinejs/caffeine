import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'

// Side-effect imports register the controllers (and, transitively, their services and repositories)
// in the global component registry that the container snapshots when the app is built.
import './customer/customer.controller.js'
import './address/address.controller.js'
import './cart/cart.controller.js'
import './order/order.controller.js'
import './payment/payment.controller.js'

console.time('start')
const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
await app.ready()
await app.instance.listen({ port: 3013, host: '127.0.0.1' })
console.timeEnd('start')
process.exit(0)
