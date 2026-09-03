import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { Catalog } from './catalog.js'
import { inventoryModule } from './inventory.mod.js'

export const catalogModule: Module = mod({
  name: 'catalog',
  needs: () => [inventoryModule],
  provides: () => [Catalog],
  fn: container => {
    moduleFnCalls.push('catalog')
    container.bind(Catalog, t => t.toSelf())
  },
})
