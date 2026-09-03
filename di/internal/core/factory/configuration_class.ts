import { Binding } from '../../../binding.js'
import { Factory } from '../../../factory.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Ctor } from '../../../types.js'

export function configurationClassFactory<T>(target: Ctor, method: string | symbol, conf: Binding): Factory<T> {
  return (ctx: ResolutionContext): T => {
    const clazz = conf.factory(conf.ctx!)
    const resolvers = ctx.binding.injectionResolvers

    if (resolvers.length === 0) {
      return clazz[method]() as T
    }

    switch (resolvers.length) {
      case 1:
        return clazz[method](resolvers[0]()) as T
      case 2:
        return clazz[method](resolvers[0](), resolvers[1]()) as T
      case 3:
        return clazz[method](resolvers[0](), resolvers[1](), resolvers[2]()) as T
      case 4:
        return clazz[method](resolvers[0](), resolvers[1](), resolvers[2](), resolvers[3]()) as T
    }

    const result = new Array(resolvers.length)
    for (let i = 0; i < resolvers.length; i++) {
      result[i] = resolvers[i]()
    }

    return clazz[method](...result) as T
  }
}
