import { Container, CaffeineIoC, Options } from '@caffeinejs/core'
import { Keys } from './symbols.js'
import { Router } from './route.js'
import { Adapter, AdapterFactory, Application } from './application.js'
import { getRouter } from './decorators/registrar/registrar.js'
import { CaffeineError } from './error.js'

export type CaffeineHTTPOptions = {
  container?: Container | Options
}

export function newHTTP<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: CaffeineHTTPOptions = {},
): Application<I, REQ, A> {
  const c = options.container
  const container = c != null && typeof (c as Container).get === 'function'
    ? c as Container
    : new CaffeineIoC(c != null ? c as Partial<Options> : {})

  const adapter = adapterFactory({ container })
  const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
  const routers = new Array<Router<REQ>>(controllers.length)

  for (let i = 0; i < controllers.length; i++) {
    const { key, binding } = controllers[i]
    const rd = getRouter(key as Function)
    if (!rd) {
      throw new CaffeineError(`Cannot build router: no route definition found for router "${String(key)}"`, 'HTTP_MISSING_ROUTER')
    }

    routers[i] = rd.toRouter<REQ>(key, binding, container.wrap(key))
  }

  return new Application(container, routers, adapter)
}
