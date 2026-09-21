import { createWebApplication } from '@caffeinejs/http'

// Side-effect imports register the controllers (and, transitively, their services and repositories)
// in the global component registry that the container snapshots when the app is built.
import './customer/customer.controller.js'
import './address/address.controller.js'
import './cart/cart.controller.js'
import './order/order.controller.js'
import './payment/payment.controller.js'

const started = performance.now()
const app = createWebApplication()
await app.ready()
await app.instance.listen({ port: 3013, host: '127.0.0.1' })
// performance.now() counts from process start, so `start` covers module loading; `bootstrap` does not.
const listening = performance.now()
process.stdout.write(`start: ${listening.toFixed(3)}ms\nbootstrap: ${(listening - started).toFixed(3)}ms\n`)
await app.close()
process.exit(0)
