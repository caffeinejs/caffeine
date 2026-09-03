import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { catalogModule } from './catalog.mod.js'
import { Pricing } from './pricing.js'

export const pricingModule: Module = mod({
  name: 'pricing',
  needs: () => [catalogModule],
  provides: () => [Pricing],
  fn: container => {
    moduleFnCalls.push('pricing')
    container.bind(Pricing, t => t.toSelf())
  },
})
