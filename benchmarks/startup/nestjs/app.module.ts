import { Module } from '@nestjs/common'

import { AddressModule } from './address/address.module.js'
import { CartModule } from './cart/cart.module.js'
import { CustomerModule } from './customer/customer.module.js'
import { OrderModule } from './order/order.module.js'
import { PaymentModule } from './payment/payment.module.js'
import { SharedModule } from './shared/shared.module.js'

@Module({
  imports: [SharedModule, CustomerModule, AddressModule, CartModule, OrderModule, PaymentModule],
})
export class AppModule {}
