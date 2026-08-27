import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { Inventory } from './inventory.js'
import { pricingModule } from './pricing.mod.js'

export const inventoryModule: Module = mod({
  name: 'inventory',
  needs: () => [pricingModule],
  provides: () => [Inventory],
  fn: container => {
    moduleFnCalls.push('inventory')
    container.bind(Inventory).toSelf()
  },
})
