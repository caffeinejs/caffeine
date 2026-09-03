import { token } from '../../../../key.js'
import { mod, type Module } from '../../../../module.js'
import { moduleFnCalls } from '../trace.js'
import { alphaModule } from './alpha.mod.js'

export const betaModule: Module = mod({
  name: 'beta',
  provides: () => [alphaModule],
  fn: container => {
    moduleFnCalls.push('beta')
    container.bind(token<any>('beta'), t => t.toValue('beta'))
  },
})
