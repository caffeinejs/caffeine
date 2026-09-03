import { mod, type Module } from '../../../../module.js'
import { token } from '../../../../key.js'
import { moduleFnCalls } from '../trace.js'
import { betaModule } from './beta.mod.js'

export const alphaModule: Module = mod({
  name: 'alpha',
  provides: () => [betaModule],
  fn: container => {
    moduleFnCalls.push('alpha')
    container.bind(token<any>('alpha'), t => t.toValue('alpha'))
  },
})
