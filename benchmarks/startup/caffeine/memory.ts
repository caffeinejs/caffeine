import { createWebApplication } from '@caffeinejs/http'

// Same app graph as app.ts, built but never listened on: this worker measures the resident memory
// of the constructed application, not its network stack.
import './customer/customer.controller.js'
import './address/address.controller.js'
import './cart/cart.controller.js'
import './order/order.controller.js'
import './payment/payment.controller.js'

const app = createWebApplication()
await app.ready()

// Twice: the first pass can leave objects that only become unreachable once finalizers have run.
global.gc!()
global.gc!()
process.stdout.write(JSON.stringify(process.memoryUsage()))

await app.close()
process.exit(0)
