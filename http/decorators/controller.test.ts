import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Keys } from '../symbols.js'
import { Controller } from './controller.js'
import { Get } from './verbs.js'

@Controller('/stock')
@Profile('controller-labels')
class StockController {
  @Get('/')
  async list(): Promise<string> {
    return 'listed'
  }
}

// Packages that act on every request entrypoint, whatever its transport, find a controller by the neutral label alone.
describe('@Controller', () => {
  it('labels the class a controller and an entrypoint', async () => {
    const di = new CaffeineIoC({ profiles: ['controller-labels'] })
    await di.init()

    expect(di.getBindingsByLabel(Keys.CONTROLLER).map(({ key }) => key)).toEqual([StockController])
    expect(di.getBindingsByLabel(Keys.ENTRYPOINT).map(({ key }) => key)).toEqual([StockController])
    expect(Keys.ENTRYPOINT).toBe(Symbol.for('@caffeinejs:entrypoint'))
  })
})
