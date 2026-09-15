import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'

// Same app graph as app.ts, built but never listened on: this worker measures the resident memory
// of the constructed application, not its network stack.
import './customer/customer.controller.js'
import './address/address.controller.js'
import './cart/cart.controller.js'
import './order/order.controller.js'
import './payment/payment.controller.js'

const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
await app.ready()

global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))

await app.close()
process.exit(0)
